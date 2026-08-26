"""The evaluation report — a single self-contained HTML file for an agronomist.

Everything is inlined (CSS, plots as base64 PNGs) so the file can be emailed or
committed beside the model artifact and opened anywhere. The report leads with
the one thing a reader must understand before looking at any number: the hard
label is a *sample* from the soft distribution, so top-1-vs-hard cannot exceed
~55 % and is not the score to judge the model by — NDCG@k and KL are.
"""

from __future__ import annotations

import base64
import io
from dataclasses import dataclass
from pathlib import Path

import matplotlib

matplotlib.use("Agg")  # headless: no display, render straight to PNG bytes
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from jinja2 import Environment, select_autoescape  # noqa: E402

from aaroh_ai.evaluation.golden import GoldenReport  # noqa: E402
from aaroh_ai.evaluation.metrics import (  # noqa: E402
    CalibrationBins,
    EvalSummary,
    PerClassScores,
)


@dataclass
class ReportContext:
    meta: dict[str, object]
    summary: EvalSummary
    confusion: np.ndarray
    per_class: PerClassScores
    calibration: CalibrationBins
    top_pairs: list[tuple[str, str, int]]
    golden: GoldenReport
    classes: tuple[str, ...]
    gates: dict[str, object]
    baseline_summary: EvalSummary | None = None


def _png_data_uri(fig) -> str:
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=110, bbox_inches="tight")
    plt.close(fig)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def _confusion_png(cm: np.ndarray, classes: tuple[str, ...]) -> str:
    row_tot = cm.sum(axis=1, keepdims=True)
    norm = np.divide(cm, row_tot, out=np.zeros(cm.shape, float), where=row_tot > 0)
    fig, ax = plt.subplots(figsize=(8.5, 7.5))
    im = ax.imshow(norm, cmap="Blues", vmin=0, vmax=1)
    ax.set_xticks(range(len(classes)))
    ax.set_yticks(range(len(classes)))
    ax.set_xticklabels(classes, rotation=90, fontsize=7)
    ax.set_yticklabels(classes, fontsize=7)
    ax.set_xlabel("predicted")
    ax.set_ylabel("true")
    ax.set_title("Confusion matrix (row-normalised = recall)")
    fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04)
    return _png_data_uri(fig)


def _reliability_png(cal: CalibrationBins) -> str:
    centers = 0.5 * (cal.edges[:-1] + cal.edges[1:])
    fig, ax = plt.subplots(figsize=(5.2, 4.2))
    ax.plot([0, 1], [0, 1], "--", color="#999", label="perfect")
    mask = cal.bin_count > 0
    ax.plot(cal.bin_confidence[mask], cal.bin_accuracy[mask], "o-", color="#1f6feb", label="model")
    ax.bar(centers, cal.bin_count / max(cal.bin_count.max(), 1) * 0.28,
           width=(cal.edges[1] - cal.edges[0]) * 0.9, alpha=0.15, color="#1f6feb")
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    ax.set_xlabel("predicted confidence (top class)")
    ax.set_ylabel("empirical accuracy")
    ax.set_title("Reliability diagram")
    ax.legend(loc="upper left", fontsize=8)
    return _png_data_uri(fig)


_TEMPLATE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Aaroh crop-ranker — evaluation report</title>
<style>
:root { color-scheme: light; }
body { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
  max-width: 980px; margin: 2rem auto; padding: 0 1.2rem;
  color: #1c2024; background: #fff; line-height: 1.5; }
h1 { font-size: 1.6rem; margin-bottom: .2rem; }
h2 { font-size: 1.2rem; margin-top: 2rem; border-bottom: 2px solid #eaecef; padding-bottom: .3rem; }
.sub { color: #57606a; margin-top: 0; }
table { border-collapse: collapse; width: 100%; margin: .6rem 0; font-size: .9rem; }
th, td { border: 1px solid #e2e5e9; padding: .4rem .55rem; text-align: right; }
th:first-child, td:first-child { text-align: left; }
thead th { background: #f6f8fa; }
.badge { display: inline-block; padding: .12rem .5rem;
  border-radius: 999px; font-size: .8rem; font-weight: 600; }
.pass { background: #dafbe1; color: #116329; } .fail { background: #ffebe9; color: #a40e26; }
.callout { border-left: 4px solid #d29922; background: #fff8e6;
  padding: .8rem 1rem; border-radius: 4px; margin: 1rem 0; }
.meta { font-size: .82rem; color: #57606a; }
.kv { display: grid; grid-template-columns: max-content 1fr; gap: .15rem 1rem; font-size: .85rem; }
.kv div:nth-child(odd) { color: #57606a; }
code { background: #f6f8fa; padding: .05rem .3rem; border-radius: 3px; font-size: .85em; }
img { max-width: 100%; height: auto; }
.small { font-size: .82rem; color: #57606a; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; align-items: start; }
</style></head><body>

<h1>Aaroh crop-ranker — evaluation report</h1>
<p class="sub">Model <code>{{ meta.version }}</code> ·
  {{ meta.framework }} / {{ meta.objective }} ·
  gates: <span class="badge {{ 'pass' if gates.passed else 'fail' }}"
    >{{ 'PASS' if gates.passed else 'FAIL' }}</span></p>

<div class="kv">
  <div>Trained at</div><div>{{ meta.trained_at }}</div>
  <div>Dataset hash</div><div><code>{{ meta.dataset_hash }}</code></div>
  <div>Feature spec</div><div>v{{ meta.feature_spec_version }}</div>
  <div>Rows (train / val / test)</div>
  <div>{{ meta.n_train }} / {{ meta.n_val }} / {{ meta.n_test }}</div>
  {% if meta.git_commit %}<div>Git commit</div>
  <div><code>{{ meta.git_commit }}</code></div>{% endif %}
</div>

<div class="callout">
<strong>Read this before the numbers.</strong> The training <em>hard</em> label is a
single crop <em>sampled</em> from each row's soft probability distribution — it is
<em>not</em> the most likely crop. On this dataset <code>argmax(soft) == hard</code>
for only <strong>{{ '%.1f'|format(summary.argmax_soft_vs_hard * 100) }}%</strong> of rows.
That is the <strong>ceiling</strong> on top-1 accuracy measured against the hard label:
even a model that reproduced the soft distribution perfectly would "disagree" with the
sampled label ~{{ '%.0f'|format((1 - summary.argmax_soft_vs_hard) * 100) }}% of the time.
So <strong>top-1 ≈ {{ '%.0f'|format(summary.top1 * 100) }}% is expected, not broken.</strong>
Judge the model by <strong>NDCG@3</strong> and <strong>KL</strong> (vs the soft target)
and by top-3/top-5 coverage.
</div>

<h2>Headline metrics</h2>
<table>
<thead><tr><th>Metric</th><th>Value</th>
{% if baseline %}<th>Baseline</th><th>Δ</th>{% endif %}
<th>Read as</th></tr></thead>
<tbody>
{% for row in metric_rows %}
<tr><td>{{ row.label }}</td><td>{{ row.value }}</td>
{% if baseline %}<td>{{ row.base }}</td><td>{{ row.delta }}</td>{% endif %}
<td class="small">{{ row.note }}</td></tr>
{% endfor %}
</tbody></table>
<p class="small">Top-1 is shown against its ceiling of
{{ '%.3f'|format(summary.argmax_soft_vs_hard) }}. n(eval) = {{ summary.n_eval }}.</p>

<h2>Gates</h2>
<table>
<thead><tr><th>Gate</th><th>Result</th><th>Detail</th></tr></thead>
<tbody>
{% for g in gate_rows %}
<tr><td>{{ g.name }}</td>
<td><span class="badge {{ 'pass' if g.passed else 'fail' }}"
  >{{ 'PASS' if g.passed else 'FAIL' }}</span></td>
<td class="small">{{ g.detail }}</td></tr>
{% endfor %}
</tbody></table>

<h2>Calibration &amp; confusion</h2>
<div class="grid2">
  <div><img alt="reliability diagram" src="{{ reliability_png }}"></div>
  <div><img alt="confusion matrix" src="{{ confusion_png }}"></div>
</div>

<h2>Most-confused crop pairs</h2>
<p class="small">Watch the known-adjacent pairs: Moong↔Urad, Wheat↔Chickpea, Bajra↔Jowar.
Confusion between agronomically similar crops is far less costly than confusion
between dissimilar ones.</p>
<table>
<thead><tr><th>True</th><th>Predicted as</th><th>Count</th></tr></thead>
<tbody>
{% for t, p, c in top_pairs %}<tr><td>{{ t }}</td><td>{{ p }}</td><td>{{ c }}</td></tr>{% endfor %}
</tbody></table>

<h2>Per-crop precision / recall / F1</h2>
<table>
<thead><tr><th>Crop</th><th>Precision</th><th>Recall</th><th>F1</th><th>Support</th></tr></thead>
<tbody>
{% for r in per_class_rows %}
<tr><td>{{ r.crop }}</td><td>{{ '%.3f'|format(r.p) }}</td><td>{{ '%.3f'|format(r.r) }}</td>
<td>{{ '%.3f'|format(r.f1) }}</td><td>{{ r.support }}</td></tr>
{% endfor %}
</tbody></table>

<h2>Agronomic golden tests
  <span class="badge {{ 'pass' if golden.passed else 'fail' }}">
  {{ golden.n_passed }}/{{ golden.n_total }}</span></h2>
<table>
<thead><tr><th>Case</th><th>Result</th><th>Checks</th><th>Model top-5</th></tr></thead>
<tbody>
{% for r in golden_rows %}
<tr><td>{{ r.name }}<div class="small">{{ r.rationale }}</div></td>
<td><span class="badge {{ 'pass' if r.passed else 'fail' }}"
  >{{ 'PASS' if r.passed else 'FAIL' }}</span></td>
<td class="small">{% for c in r.checks %}{{ c }}<br>{% endfor %}</td>
<td class="small">{{ r.top5 }}</td></tr>
{% endfor %}
</tbody></table>

<p class="meta">Generated by <code>aaroh_ai.evaluation.report</code>. Metrics computed on the
held-out test split. This file is self-contained (plots inlined as PNGs).</p>
</body></html>
"""


def _metric_rows(summary: EvalSummary, baseline: EvalSummary | None):
    spec = [
        ("top1", "Top-1 (vs hard)", "intuition only — capped by the ceiling above"),
        ("top3", "Top-3 (vs hard)", "is the right crop among the first three?"),
        ("top5", "Top-5 (vs hard)", "coverage for the shortlist UI"),
        ("ndcg_at_3", "NDCG@3 (vs soft)", "PRIMARY — ranking quality vs the true distribution"),
        ("ndcg_at_5", "NDCG@5 (vs soft)", "ranking quality, deeper list"),
        ("mrr", "MRR (vs hard)", "how high the sampled crop sits on average"),
        ("map_at_3", "MAP@3 (vs hard)", "precision of the top-3 for the sampled crop"),
        ("kl_divergence", "KL(true ‖ pred)", "PRIMARY — lower is closer to the soft target"),
        ("ece", "ECE", "calibration gap; lower is better"),
        ("brier", "Brier", "squared error vs one-hot hard label"),
    ]
    d = summary.to_dict()
    b = baseline.to_dict() if baseline else None
    rows = []
    for key, label, note in spec:
        row = {"label": label, "value": f"{d[key]:.4f}", "note": note}
        if b is not None:
            row["base"] = f"{b[key]:.4f}"
            row["delta"] = f"{d[key] - b[key]:+.4f}"
        rows.append(row)
    return rows


def render_report_html(ctx: ReportContext) -> str:
    env = Environment(autoescape=select_autoescape(["html"]))
    tmpl = env.from_string(_TEMPLATE)

    per_class_rows = [
        {"crop": ctx.classes[i], "p": float(ctx.per_class.precision[i]),
         "r": float(ctx.per_class.recall[i]), "f1": float(ctx.per_class.f1[i]),
         "support": int(ctx.per_class.support[i])}
        for i in range(len(ctx.classes))
    ]
    golden_rows = [
        {"name": r.name, "passed": r.passed, "rationale": r.rationale,
         "checks": r.checks,
         "top5": ", ".join(f"{c} {p:.2f}" for c, p in r.top5)}
        for r in ctx.golden.results
    ]
    gate_rows = ctx.gates.get("checks", [])

    return tmpl.render(
        meta=ctx.meta,
        summary=ctx.summary,
        baseline=ctx.baseline_summary is not None,
        metric_rows=_metric_rows(ctx.summary, ctx.baseline_summary),
        gates=ctx.gates,
        gate_rows=gate_rows,
        reliability_png=_reliability_png(ctx.calibration),
        confusion_png=_confusion_png(ctx.confusion, ctx.classes),
        top_pairs=ctx.top_pairs,
        per_class_rows=per_class_rows,
        golden=ctx.golden,
        golden_rows=golden_rows,
    )


def write_report(path: str | Path, ctx: ReportContext) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(render_report_html(ctx), encoding="utf-8")
    return path

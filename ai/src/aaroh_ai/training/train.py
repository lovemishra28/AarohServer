"""Command-line entrypoint: ``python -m aaroh_ai.training.train --config <yaml>``.

Loads a YAML training config, runs the pipeline, prints a compact verdict, and
exits non-zero if the gates fail — so the same command works by hand and in CI.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import yaml

from aaroh_ai.training.pipeline import run_training


def load_config(path: str | Path) -> dict:
    with open(path, encoding="utf-8") as fh:
        cfg = yaml.safe_load(fh)
    if not isinstance(cfg, dict):
        raise ValueError(f"config {path} did not parse to a mapping")
    return cfg


def _print_verdict(result) -> None:
    s = result.summary
    print(f"\n=== {result.version} ===")
    print(f"  framework/objective : {result.record.algo} / {result.record.objective}")
    print(f"  top1/top3/top5      : {s.top1:.3f} / {s.top3:.3f} / {s.top5:.3f} "
          f"(top-1 ceiling {s.argmax_soft_vs_hard:.3f})")
    print(f"  NDCG@3 / KL         : {s.ndcg_at_3:.4f} / {s.kl_divergence:.4f}")
    print(f"  ECE / Brier         : {s.ece:.4f} / {s.brier:.4f}")
    print(f"  golden              : {result.golden.n_passed}/{result.golden.n_total}")
    for c in result.gates["checks"]:
        print(f"    [{'PASS' if c['passed'] else 'FAIL'}] {c['name']} — {c['detail']}")
    if result.onnx_parity is not None:
        p = result.onnx_parity
        print(f"  ONNX parity         : max|Δp|={p.max_abs_diff:.2e} over {p.n_rows} rows (OK)")
    print(f"  gates               : {'PASS' if result.gates['passed'] else 'FAIL'}")
    print(f"  activated           : {result.activated}")
    print(f"  report              : {result.report_path}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Train and register an Aaroh crop-ranker.")
    parser.add_argument("--config", required=True, help="path to a YAML training config")
    parser.add_argument("--data-dir", default=None, help="override raw dataset dir")
    parser.add_argument(
        "--models-root", default=None, help="override models/ root (registry+artifacts)"
    )
    args = parser.parse_args(argv)

    config = load_config(args.config)
    result = run_training(config, data_dir=args.data_dir, models_root=args.models_root)
    _print_verdict(result)
    return 0 if result.gates["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())

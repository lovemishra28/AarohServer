"""Metrics for a *ranking* model with *soft* targets — pure numpy, no deps.

Crop recommendation is a ranking problem, not single-label classification, and
the target is a probability distribution over crops, not one crop. So the
honest metrics are:

* **NDCG@k** with the soft label as graded relevance — did we put the crops the
  agronomy model considers most suitable near the top?
* **KL(true ‖ pred)** — how far is our predicted distribution from the soft
  target?
* **top-k accuracy / MRR** against the *hard* label — intuitive, but read them
  next to :func:`argmax_soft_vs_hard_agreement`, which is the ceiling: the hard
  label is only a *sample* from the soft distribution, so even a perfect model
  cannot match it more than ~55 % of the time. Top-1-vs-hard is therefore a
  floor-lit vanity metric; NDCG and KL are the ones to trust.
* **ECE / reliability bins** — are the predicted probabilities calibrated?

All functions take ``proba`` of shape ``(n_rows, n_classes)`` (rows need not sum
to exactly 1) and integer ``y_true`` class indices of shape ``(n_rows,)``.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

ArrayF = np.ndarray
ArrayI = np.ndarray


def _order_desc(proba: ArrayF) -> ArrayI:
    """Class indices per row, best first. Stable so ties are deterministic."""
    return np.argsort(-proba, axis=1, kind="stable")


def top_k_indices(proba: ArrayF, k: int) -> ArrayI:
    """The top-``k`` class indices per row (descending by probability)."""
    k = min(k, proba.shape[1])
    return _order_desc(proba)[:, :k]


def true_ranks(proba: ArrayF, y_true: ArrayI) -> ArrayI:
    """1-indexed rank of the true class in each row's ordering."""
    order = _order_desc(proba)
    return (order == y_true[:, None]).argmax(axis=1) + 1


def top_k_accuracy(proba: ArrayF, y_true: ArrayI, k: int) -> float:
    """Fraction of rows whose true class is within the top ``k`` predictions."""
    topk = top_k_indices(proba, k)
    return float((topk == y_true[:, None]).any(axis=1).mean())


def mrr(proba: ArrayF, y_true: ArrayI) -> float:
    """Mean reciprocal rank of the true (hard) class."""
    return float((1.0 / true_ranks(proba, y_true)).mean())


def map_at_k(proba: ArrayF, y_true: ArrayI, k: int) -> float:
    """MAP@k with a single relevant item (the hard label).

    With one relevant document, average precision is ``1/rank`` when the item is
    within the top ``k``, else 0; MAP is the mean over rows.
    """
    ranks = true_ranks(proba, y_true)
    ap = np.where(ranks <= k, 1.0 / ranks, 0.0)
    return float(ap.mean())


def ndcg_at_k(proba: ArrayF, relevance: ArrayF, k: int) -> float:
    """Mean NDCG@k using ``relevance`` (the soft labels) as graded gains.

    DCG orders classes by predicted probability; IDCG orders by true relevance.
    Rows whose ideal DCG is 0 contribute 0.
    """
    n, c = proba.shape
    kk = min(k, c)
    pred_order = _order_desc(proba)[:, :kk]
    ideal_order = _order_desc(relevance)[:, :kk]
    discounts = 1.0 / np.log2(np.arange(2, kk + 2))  # positions 1..kk
    dcg = (np.take_along_axis(relevance, pred_order, axis=1) * discounts).sum(axis=1)
    idcg = (np.take_along_axis(relevance, ideal_order, axis=1) * discounts).sum(axis=1)
    ndcg = np.divide(dcg, idcg, out=np.zeros_like(dcg), where=idcg > 0)
    return float(ndcg.mean())


def kl_divergence(pred: ArrayF, true_soft: ArrayF, eps: float = 1e-12) -> float:
    """Mean KL(true ‖ pred) over rows.

    ``true_soft`` weights the sum, so its exact zeros drop out; only ``pred`` and
    the log of ``true_soft`` are clipped, to avoid ``log(0)`` / division blow-ups.
    """
    p = np.clip(true_soft, eps, 1.0)
    q = np.clip(pred, eps, 1.0)
    per_row = np.sum(true_soft * (np.log(p) - np.log(q)), axis=1)
    return float(per_row.mean())


def brier_score(proba: ArrayF, y_true: ArrayI) -> float:
    """Multiclass Brier score: mean squared error vs the one-hot hard label."""
    n, c = proba.shape
    onehot = np.zeros_like(proba)
    onehot[np.arange(n), y_true] = 1.0
    return float(((proba - onehot) ** 2).sum(axis=1).mean())


def argmax_soft_vs_hard_agreement(soft: ArrayF, y_true: ArrayI) -> float:
    """Fraction of rows where ``argmax(soft) == hard`` — the top-1 ceiling."""
    return float((soft.argmax(axis=1) == y_true).mean())


def confusion_matrix(y_true: ArrayI, y_pred: ArrayI, n_classes: int) -> ArrayI:
    """Counts with rows = true class, columns = predicted class."""
    cm = np.zeros((n_classes, n_classes), dtype=np.int64)
    np.add.at(cm, (y_true, y_pred), 1)
    return cm


@dataclass
class PerClassScores:
    precision: ArrayF
    recall: ArrayF
    f1: ArrayF
    support: ArrayI


def per_class_prf(cm: ArrayI) -> PerClassScores:
    """Per-class precision / recall / F1 / support from a confusion matrix."""
    tp = np.diag(cm).astype(np.float64)
    pred_tot = cm.sum(axis=0).astype(np.float64)  # column sums
    true_tot = cm.sum(axis=1).astype(np.float64)  # row sums
    precision = np.divide(tp, pred_tot, out=np.zeros_like(tp), where=pred_tot > 0)
    recall = np.divide(tp, true_tot, out=np.zeros_like(tp), where=true_tot > 0)
    denom = precision + recall
    f1 = np.divide(2 * precision * recall, denom, out=np.zeros_like(tp), where=denom > 0)
    return PerClassScores(precision, recall, f1, true_tot.astype(np.int64))


def top_confusion_pairs(
    cm: ArrayI, classes: tuple[str, ...], top_n: int = 10
) -> list[tuple[str, str, int]]:
    """Largest off-diagonal (true, predicted, count) cells, most confused first."""
    pairs: list[tuple[str, str, int]] = []
    n = cm.shape[0]
    for i in range(n):
        for j in range(n):
            if i != j and cm[i, j] > 0:
                pairs.append((classes[i], classes[j], int(cm[i, j])))
    pairs.sort(key=lambda t: t[2], reverse=True)
    return pairs[:top_n]


@dataclass
class CalibrationBins:
    bin_confidence: ArrayF
    bin_accuracy: ArrayF
    bin_count: ArrayI
    edges: ArrayF


def calibration_bins(proba: ArrayF, y_true: ArrayI, n_bins: int = 10) -> CalibrationBins:
    """Reliability-diagram data: mean confidence, accuracy and count per bin."""
    conf = proba.max(axis=1)
    pred = proba.argmax(axis=1)
    correct = (pred == y_true).astype(np.float64)
    edges = np.linspace(0.0, 1.0, n_bins + 1)
    bin_conf = np.zeros(n_bins)
    bin_acc = np.zeros(n_bins)
    bin_cnt = np.zeros(n_bins, dtype=np.int64)
    for i in range(n_bins):
        lo, hi = edges[i], edges[i + 1]
        mask = (conf > lo) & (conf <= hi) if i > 0 else (conf >= lo) & (conf <= hi)
        cnt = int(mask.sum())
        bin_cnt[i] = cnt
        if cnt:
            bin_conf[i] = conf[mask].mean()
            bin_acc[i] = correct[mask].mean()
    return CalibrationBins(bin_conf, bin_acc, bin_cnt, edges)


def expected_calibration_error(proba: ArrayF, y_true: ArrayI, n_bins: int = 10) -> float:
    """Top-label ECE: weighted mean gap between confidence and accuracy."""
    b = calibration_bins(proba, y_true, n_bins)
    n = int(b.bin_count.sum())
    if n == 0:
        return 0.0
    gaps = np.abs(b.bin_accuracy - b.bin_confidence) * b.bin_count
    return float(gaps.sum() / n)


@dataclass
class EvalSummary:
    """The headline metrics bundle, ready to serialise into the registry."""

    top1: float
    top3: float
    top5: float
    ndcg_at_3: float
    ndcg_at_5: float
    mrr: float
    map_at_3: float
    kl_divergence: float
    ece: float
    brier: float
    argmax_soft_vs_hard: float
    n_eval: int

    def to_dict(self) -> dict[str, float | int]:
        return {
            "top1": self.top1, "top3": self.top3, "top5": self.top5,
            "ndcg_at_3": self.ndcg_at_3, "ndcg_at_5": self.ndcg_at_5,
            "mrr": self.mrr, "map_at_3": self.map_at_3,
            "kl_divergence": self.kl_divergence, "ece": self.ece,
            "brier": self.brier, "argmax_soft_vs_hard": self.argmax_soft_vs_hard,
            "n_eval": self.n_eval,
        }


def evaluate(proba: ArrayF, y_true: ArrayI, soft: ArrayF) -> EvalSummary:
    """Compute the full headline bundle in one call."""
    return EvalSummary(
        top1=top_k_accuracy(proba, y_true, 1),
        top3=top_k_accuracy(proba, y_true, 3),
        top5=top_k_accuracy(proba, y_true, 5),
        ndcg_at_3=ndcg_at_k(proba, soft, 3),
        ndcg_at_5=ndcg_at_k(proba, soft, 5),
        mrr=mrr(proba, y_true),
        map_at_3=map_at_k(proba, y_true, 3),
        kl_divergence=kl_divergence(proba, soft),
        ece=expected_calibration_error(proba, y_true),
        brier=brier_score(proba, y_true),
        argmax_soft_vs_hard=argmax_soft_vs_hard_agreement(soft, y_true),
        n_eval=int(len(y_true)),
    )

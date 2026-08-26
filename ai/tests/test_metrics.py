"""Metrics: deterministic hand-checks of the ranking/soft-target maths."""

from __future__ import annotations

import numpy as np

from aaroh_ai.evaluation import metrics as M


def test_topk_perfect_and_ties():
    proba = np.array([[0.6, 0.3, 0.1], [0.1, 0.8, 0.1]])
    y = np.array([0, 1])
    assert M.top_k_accuracy(proba, y, 1) == 1.0

    # Uniform rows: stable argsort keeps original order, so top-1 is always class 0.
    u = np.full((4, 4), 0.25)
    yy = np.array([0, 1, 2, 3])
    assert M.top_k_accuracy(u, yy, 1) == 0.25   # only the y==0 row "hits"
    assert M.top_k_accuracy(u, yy, 3) == 0.75   # classes {0,1,2}


def test_true_ranks_and_mrr():
    proba = np.array([[0.6, 0.3, 0.1], [0.1, 0.2, 0.7]])
    y = np.array([2, 1])  # ranks: 3 and 2
    assert list(M.true_ranks(proba, y)) == [3, 2]
    assert abs(M.mrr(proba, y) - np.mean([1 / 3, 1 / 2])) < 1e-12


def test_ndcg_known_value():
    relevance = np.array([[1.0, 0.0, 0.0, 0.0]])
    perfect = np.array([[0.9, 0.05, 0.03, 0.02]])   # class 0 first
    second = np.array([[0.05, 0.9, 0.03, 0.02]])    # class 0 second
    assert abs(M.ndcg_at_k(perfect, relevance, 3) - 1.0) < 1e-12
    assert abs(M.ndcg_at_k(second, relevance, 3) - (1 / np.log2(3))) < 1e-9


def test_kl_zero_and_ln2():
    p = np.array([[0.2, 0.3, 0.5]])
    assert abs(M.kl_divergence(p, p)) < 1e-12
    true = np.array([[1.0, 0.0]])
    pred = np.array([[0.5, 0.5]])
    assert abs(M.kl_divergence(pred, true) - np.log(2)) < 1e-9


def test_argmax_soft_vs_hard():
    soft = np.array([[0.7, 0.3], [0.4, 0.6], [0.9, 0.1]])
    y = np.array([0, 0, 0])  # argmax soft = [0,1,0] → agreement 2/3
    assert abs(M.argmax_soft_vs_hard_agreement(soft, y) - 2 / 3) < 1e-12


def test_confusion_and_prf():
    y_true = np.array([0, 0, 1, 1, 2])
    y_pred = np.array([0, 1, 1, 1, 2])
    cm = M.confusion_matrix(y_true, y_pred, 3)
    assert cm.tolist() == [[1, 1, 0], [0, 2, 0], [0, 0, 1]]
    prf = M.per_class_prf(cm)
    assert abs(prf.recall[0] - 0.5) < 1e-12          # 1 of 2 class-0 correct
    assert abs(prf.precision[1] - (2 / 3)) < 1e-12   # 2 of 3 predicted-1 correct
    assert prf.support.tolist() == [2, 2, 1]


def test_brier_perfect_zero():
    proba = np.array([[1.0, 0.0], [0.0, 1.0]])
    y = np.array([0, 1])
    assert abs(M.brier_score(proba, y)) < 1e-12


def test_ece_and_bins():
    # Two rows, confidence 0.9 but only one correct → gap 0.4 in the top bin.
    proba = np.array([[0.9, 0.1], [0.9, 0.1]])
    y = np.array([0, 1])
    ece = M.expected_calibration_error(proba, y, n_bins=10)
    assert abs(ece - 0.4) < 1e-9


def test_evaluate_bundle_shape():
    proba = np.array([[0.7, 0.2, 0.1], [0.2, 0.7, 0.1], [0.1, 0.2, 0.7]])
    y = np.array([0, 1, 2])
    soft = proba.copy()
    s = M.evaluate(proba, y, soft)
    d = s.to_dict()
    for k in ("top1", "top3", "ndcg_at_3", "kl_divergence", "ece", "brier",
              "argmax_soft_vs_hard", "n_eval"):
        assert k in d
    assert s.n_eval == 3
    assert s.top1 == 1.0

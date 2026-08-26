# ADR-0004: Two engines — probabilistic ranker vs deterministic agronomy

- **Status:** Accepted
- **Date:** 2026-08-26
- **Deciders:** mishr (solo/lead builder)

## Context

Aaroh's promise to a farmer is specific, **costed** advice: which crops suit this
field, and for a chosen crop, how much fertiliser to buy in real units (kg and
50 kg bags of Urea / DAP / MOP) and what it costs. That answer spans two very
different kinds of computation:

- **A judgement under uncertainty** — of the 20 candidate crops, which fit this
  soil, weather, and season, and how confident are we? This is inherently
  statistical and is learned from data.
- **An arithmetic calculation** — given a chosen crop and a soil test, the
  nutrient deficit, the product quantities that close it, and their price. This
  is deterministic agronomy: formulas, conversion factors, and current prices.

The failure mode we must avoid is letting these bleed into each other: a model
that outputs rupee amounts (a black-box price nobody can audit), or a fertiliser
calculation buried inside a learned function (arithmetic you cannot check). Either
way the farmer receives a number that *looks* authoritative but cannot be
explained or corrected.

## Decision

**Two engines, kept strictly separate and never merged.**

| Engine | Kind | Owns | Phase |
|---|---|---|---|
| **Crop ranker** | probabilistic ML (GBDT on soft labels) | *Which* crops suit the field, ranked, with calibrated confidence | 1 |
| **Agronomy engine** | deterministic formulas | *How much* fertiliser (in purchasable units) and *what it costs* | 2 |

The ranker's output is a ranked list with probabilities and nothing more. The
agronomy engine takes a **chosen** crop plus the soil reading and produces the
quantities and cost by transparent calculation. The ranker never emits a
quantity or a price; the agronomy engine never makes a probabilistic judgement
about crop suitability.

**A corollary rule:** field size (area) is applied **only after** prediction, to
scale the agronomy engine's quantities and cost. It is **never a feature** of the
ranker — a field's suitability for a crop does not depend on how big it is, and
feeding area to the model would invite spurious correlations.

## Consequences

- **Every number is explainable.** What the farmer sees is either a calibrated
  probability (from a model we evaluate with NDCG@3, KL, and calibration) or a
  deterministic calculation (that a human can re-derive by hand). Nothing is a
  guess dressed up as arithmetic.
- **The two halves evolve independently.** The ranker can be retrained, tuned,
  and re-registered without touching fertiliser formulas; prices and agronomy
  constants can change without retraining a model.
- **Debuggability.** A wrong recommendation can be localised — either the ranking
  was off (a model/eval problem) or the arithmetic was off (a formula/price
  problem) — because the two never commingle.
- Phase 1 builds and hardens only the ranker; the agronomy engine is deliberately
  out of scope until Phase 2, which is why the ranker's contract stops at a
  ranked list.

## Alternatives considered

- **One end-to-end model** that maps soil readings directly to a costed fertiliser
  plan — maximally "AI", but turns transparent agronomy into an unauditable
  black box and couples price/quantity logic to model retraining. Rejected: it
  breaks the core promise that advice is explainable.
- **Rules-only, no ML** for crop choice — fully transparent but too brittle to
  capture the graded, overlapping suitability the soft-label data expresses.
  Rejected in favour of a calibrated ranker for the *choice* while keeping the
  *quantities* deterministic.

"""``aaroh-recommend`` — get a costed recommendation from the command line.

This is the Phase-2 checkpoint's proof: a recommendation that runs end-to-end
without Docker, Postgres, or the HTTP server. Two modes:

* **Ranked** (default): the ML ranker scores all crops for the reading, then the
  deterministic agronomy engine costs each and splits Segment A / Segment B.
  Needs a loadable model (ONNX or a framework).
* **Single crop** (``--crop``): skip the ranker and cost exactly one crop. This
  path needs *no* model at all, so it always runs — handy for auditing the
  agronomy numbers directly.

Enter a reading with individual flags (``--n 100 --p 4 ...``) or hand a whole
reading in as JSON (``--json reading.json`` or an inline ``--json '{...}'``).

Examples::

    aaroh-recommend --n 100 --p 4 --k 50 --ph 8.1 --ec 420 --moisture 22 \\
        --humidity 55 --rainfall 60 --soil-type Black --season Rabi --area 1.2
    aaroh-recommend --crop Wheat --n 90 --p 5 --k 60 --ph 7.8 --ec 400 \\
        --moisture 20 --humidity 50 --rainfall 40 --area 1.0
"""

from __future__ import annotations

import argparse
import json
import sys

from aaroh_ai.services.agronomy import (
    classify_soil,
    load_region_config,
    recommend,
    recommend_for_crop,
)

# Raw reading keys the feature pipeline understands (temperature optional).
_NUMERIC_FLAGS = {
    "n": "N", "p": "P", "k": "K", "ph": "ph", "ec": "ec",
    "moisture": "moisture", "temperature": "temperature",
    "humidity": "humidity", "rainfall": "rainfall",
}


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="aaroh-recommend",
        description="Deterministic, costed crop + fertiliser recommendation from a soil reading.",
    )
    # Reading — individual flags
    g = p.add_argument_group("soil reading (elemental mg/kg unless noted)")
    g.add_argument("--n", type=float, help="probe nitrogen, mg/kg")
    g.add_argument("--p", type=float, help="probe phosphorus, mg/kg")
    g.add_argument("--k", type=float, help="probe potassium, mg/kg")
    g.add_argument("--ph", type=float, help="soil pH")
    g.add_argument("--ec", type=float, help="bulk EC, µS/cm")
    g.add_argument("--moisture", type=float, help="volumetric water content, %%")
    g.add_argument("--temperature", type=float, help="root-zone soil temp, °C (optional)")
    g.add_argument("--humidity", type=float, help="relative humidity, %%")
    g.add_argument("--rainfall", type=float, help="seasonal rainfall, mm")
    g.add_argument("--soil-type", default="Black", help="soil class (default: Black)")
    g.add_argument("--season", default="Rabi", help="season (default: Rabi)")
    g.add_argument("--json", dest="json_in", help="reading as a JSON file path or inline string")

    # Context
    c = p.add_argument_group("recommendation context")
    c.add_argument("--region", default="chambal", help="region code (default: chambal)")
    c.add_argument("--area", type=float, default=1.0, help="field size in hectares (default: 1.0)")
    c.add_argument("--crop", help="cost only this crop; skips the ML ranker (no model needed)")
    c.add_argument("--top", type=int, default=5, help="crops to show per segment (default: 5)")
    c.add_argument(
        "--calibrated", action="store_true",
        help="probe NPK is calibrated for this device",
    )
    c.add_argument("--format", choices=["text", "json"], default="text", help="output format")
    c.add_argument("--registry", default=None, help="override path to registry.json")
    c.add_argument("--region-dir", default=None, help="override the regions config directory")
    return p


def _reading_from_args(args: argparse.Namespace) -> dict:
    """Build the raw reading dict from --json (if given) or the individual flags."""
    if args.json_in:
        text = args.json_in
        # Treat as a path if it looks like one and exists; else parse inline.
        try:
            from pathlib import Path

            candidate = Path(text)
            if candidate.exists():
                text = candidate.read_text(encoding="utf-8")
        except OSError:
            pass
        reading = json.loads(text)
        if not isinstance(reading, dict):
            raise ValueError("--json must decode to an object")
        return reading

    reading: dict = {"soil_type": args.soil_type, "season": args.season}
    for flag, raw_key in _NUMERIC_FLAGS.items():
        val = getattr(args, flag)
        if val is not None:
            reading[raw_key] = val
    return reading


def _rupees(x: float) -> str:
    return f"₹{x:,.0f}"


def _render_fertiliser(fert: dict, indent: str) -> list[str]:
    lines = []
    gap = fert["nutrient_gap_kgha"]
    lines.append(
        f"{indent}dose (kg/ha): N {gap['n_kgha']:g}  P₂O₅ {gap['p2o5_kgha']:g}  "
        f"K₂O {gap['k2o_kgha']:g}"
    )
    for prod in fert["products"]:
        supplies = ", ".join(f"{k} {v:g}kg" for k, v in prod["supplies"].items())
        lines.append(
            f"{indent}{prod['name']:5s} × {prod['bags_50kg']} bag(s) "
            f"({prod['kg']:g} kg) → {supplies}"
        )
    lines.append(f"{indent}cost: {_rupees(fert['cost_inr'])}")
    return lines


def render_text(result: dict, reading: dict, cfg, top: int) -> str:
    out: list[str] = []
    out.append("=" * 64)
    out.append("AAROH — crop & fertiliser recommendation")
    out.append("=" * 64)
    out.append(f"region      : {result['region_code']}   area: {result['area_ha']:g} ha")
    out.append(f"model       : {result['model_version']}")
    out.append(f"agronomy    : {result['agronomy_version']}")

    # Soil classes (recomputed for display transparency).
    rating = classify_soil(
        float(reading["N"]), float(reading["P"]), float(reading["K"]),
        cfg, npk_is_calibrated=bool(reading.get("_calibrated", False)),
    )
    out.append(
        f"soil test   : N {rating.n.soil_class} ({rating.n.value_kgha:.0f} kg/ha)  "
        f"P {rating.p.soil_class} ({rating.p.value_kgha:.0f})  "
        f"K {rating.k.soil_class} ({rating.k.value_kgha:.0f})"
    )

    seg_a = result["segment_a"]
    out.append("")
    out.append(f"── Segment A · grow now, no fertiliser needed ({len(seg_a)}) ──")
    if not seg_a:
        out.append("  (none)")
    for item in seg_a[:top]:
        out.append(
            f"  {item['crop']} ({item['crop_hi']})  score {item['score']:.3f}  "
            f"[{item['rationale_code']}]"
        )

    seg_b = result["segment_b"]
    out.append("")
    out.append(f"── Segment B · viable with fertiliser ({len(seg_b)}) ──")
    if not seg_b:
        out.append("  (none)")
    for item in seg_b[:top]:
        out.append(
            f"  {item['crop']} ({item['crop_hi']})  score {item['score']:.3f}  "
            f"[{item['rationale_code']}]"
        )
        out.extend(_render_fertiliser(item["fertiliser"], indent="      "))

    if result["warnings"]:
        out.append("")
        out.append("── Warnings ──")
        for w in result["warnings"]:
            out.append(f"  • {w}")
    out.append("=" * 64)
    return "\n".join(out)


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    args = build_parser().parse_args(argv)

    try:
        reading = _reading_from_args(args)
    except (ValueError, json.JSONDecodeError) as exc:
        print(f"error: could not read the soil reading: {exc}", file=sys.stderr)
        return 2

    try:
        cfg = load_region_config(args.region, base_dir=args.region_dir)
    except (FileNotFoundError, ValueError, KeyError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    # Single-crop mode: no ML model required.
    if args.crop:
        try:
            rating = classify_soil(
                float(reading["N"]), float(reading["P"]), float(reading["K"]),
                cfg, npk_is_calibrated=args.calibrated,
            )
            recommend_for_crop(args.crop, 1.0, rating, args.area, cfg)
        except (KeyError, ValueError) as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2
        result = recommend(
            [(args.crop, 1.0)], reading, args.area, cfg,
            model_version="(none: --crop)", npk_is_calibrated=args.calibrated,
        )
    else:
        # Ranked mode: needs a loadable model.
        from aaroh_ai.inference.model_service import ModelService

        svc = ModelService(args.registry)
        if not svc.loaded:
            print(
                f"error: no model loaded ({svc.load_error}).\n"
                f"       use --crop CROP to cost a single crop without a model, "
                f"or install a model runtime.",
                file=sys.stderr,
            )
            return 3
        try:
            ranked = svc.rank(reading)
            result = recommend(
                ranked, reading, args.area, cfg,
                model_version=svc.model_version, npk_is_calibrated=args.calibrated,
            )
        except (KeyError, ValueError) as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2

    payload = result.to_dict()
    if args.format == "json":
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(render_text(payload, reading, cfg, args.top))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

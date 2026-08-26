"""Registry: CRUD, semver ordering, single-active invariant, atomic writes."""

from __future__ import annotations

import tempfile
from pathlib import Path

from aaroh_ai.training.registry import (
    FileRegistry,
    ModelRecord,
    write_artifact_metadata,
)


def _rec(version: str, **kw) -> ModelRecord:
    base = dict(algo="lightgbm", objective="multiclass", trained_at="2026-08-26T00:00:00Z",
                dataset_hash="abc", metrics={"top3": 0.5, "ndcg_at_3": 0.4},
                artifact_uri=f"artifacts/{version}",
                feature_spec_uri=f"artifacts/{version}/feature_spec.json")
    base.update(kw)
    return ModelRecord(version=version, **base)


def _fresh_registry() -> FileRegistry:
    d = Path(tempfile.mkdtemp())
    return FileRegistry(d / "registry" / "registry.json")


def test_register_get_and_persist():
    reg = _fresh_registry()
    reg.register(_rec("crop-ranker@1.0.0"))
    assert reg.get("crop-ranker@1.0.0") is not None
    # A fresh reader sees the same data (it was flushed to disk).
    reg2 = FileRegistry(reg.path)
    assert reg2.list_versions() == ["crop-ranker@1.0.0"]


def test_mirrors_postgres_columns():
    reg = _fresh_registry()
    reg.register(_rec("crop-ranker@1.0.0"))
    rec = reg.get("crop-ranker@1.0.0")
    for col in ("version", "algo", "objective", "trained_at", "dataset_hash",
                "metrics", "artifact_uri", "feature_spec_uri", "is_active", "notes"):
        assert hasattr(rec, col)


def test_latest_uses_semver():
    reg = _fresh_registry()
    reg.register(_rec("crop-ranker@1.0.0"))
    reg.register(_rec("crop-ranker@1.10.0"))   # 1.10 > 1.9 numerically, not lexically
    reg.register(_rec("crop-ranker@1.9.0"))
    assert reg.latest().version == "crop-ranker@1.10.0"


def test_single_active_invariant():
    reg = _fresh_registry()
    reg.register(_rec("crop-ranker@1.0.0"), activate=True)
    reg.register(_rec("crop-ranker@1.1.0"), activate=True)
    assert reg.active().version == "crop-ranker@1.1.0"
    assert sum(r.is_active for r in reg.records()) == 1
    reg.set_active("crop-ranker@1.0.0")
    assert reg.active().version == "crop-ranker@1.0.0"
    assert sum(r.is_active for r in reg.records()) == 1


def test_overwrite_guard():
    reg = _fresh_registry()
    reg.register(_rec("crop-ranker@1.0.0"))
    try:
        reg.register(_rec("crop-ranker@1.0.0"))
        raise AssertionError("expected duplicate-version ValueError")
    except ValueError:
        pass
    reg.register(_rec("crop-ranker@1.0.0", notes="v2"), overwrite=True)
    assert reg.get("crop-ranker@1.0.0").notes == "v2"


def test_atomic_write_leaves_no_temp():
    reg = _fresh_registry()
    reg.register(_rec("crop-ranker@1.0.0"))
    leftovers = [p.name for p in reg.path.parent.iterdir() if p.suffix == ".tmp"]
    assert leftovers == []


def test_from_dict_tolerates_extra_keys():
    rec = ModelRecord.from_dict({
        "version": "x@1.0.0", "algo": "lightgbm", "objective": "multiclass",
        "trained_at": "t", "dataset_hash": "h", "metrics": {}, "artifact_uri": "a",
        "feature_spec_uri": "b", "is_active": False, "notes": "",
        "some_future_column": "ignored",   # must not blow up
    })
    assert rec.version == "x@1.0.0"


def test_write_artifact_metadata():
    d = Path(tempfile.mkdtemp())
    rec = _rec("crop-ranker@1.0.0")
    out = write_artifact_metadata(d, rec, extra={"gates": {"passed": True}})
    assert out.exists() and out.name == "metadata.json"

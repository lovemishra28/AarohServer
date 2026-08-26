"""A file-based model registry — the source of truth for "which model is live".

Chosen over MLflow deliberately (see ADR-0003): a solo builder on a sandbox that
can't run a tracking server is better served by a single git-diffable JSON than a
service. The record schema **mirrors the Postgres ``model_registry`` table**
(version, algo, trained_at, dataset_hash, metrics, artifact_uri,
feature_spec_uri, is_active, notes) so the Node API contract is identical whether
it reads this file or, later, the database — swapping the backing store never
changes the columns.

Layout on disk::

    models/
      registry/registry.json         # the index (this module owns it)
      artifacts/<version>/           # one dir per registered model
        model.txt | model.json       # the frozen model (framework-specific)
        metadata.json                # a self-describing copy of the record
        feature_spec.json            # the exact transform used at train time
        eval_report.html             # the agronomist-facing report
        model.onnx                   # optional, if ONNX export ran

Writes are atomic (temp file + ``os.replace``) so an interrupted run can never
leave a half-written registry. Versions look like ``crop-ranker@1.2.0``.
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import asdict, dataclass, field
from pathlib import Path

REGISTRY_VERSION = "1"


@dataclass
class ModelRecord:
    """One row of the registry — mirrors the Postgres ``model_registry`` columns."""

    version: str                       # e.g. "crop-ranker@1.0.0"
    algo: str                          # "lightgbm" | "xgboost" | ...
    objective: str                     # "multiclass" | "lambdarank" | ...
    trained_at: str                    # ISO-8601 UTC
    dataset_hash: str                  # sha256 of the training features file
    metrics: dict[str, float]          # EvalSummary.to_dict()
    artifact_uri: str                  # relative path to the artifact dir
    feature_spec_uri: str              # relative path to feature_spec.json
    is_active: bool = False            # exactly one active per registry
    notes: str = ""
    tags: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> ModelRecord:
        known = {f: d.get(f) for f in cls.__dataclass_fields__}  # tolerate extra keys
        known["tags"] = d.get("tags", {}) or {}
        return cls(**known)


def _atomic_write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2, sort_keys=False)
            fh.write("\n")
        os.replace(tmp, path)  # atomic on POSIX and Windows
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def _parse_semver(version: str) -> tuple[int, int, int]:
    """Extract ``(major, minor, patch)`` from ``name@X.Y.Z`` for ordering.

    Unparseable versions sort lowest so they never masquerade as 'latest'.
    """
    tail = version.split("@", 1)[-1]
    core = tail.split("-", 1)[0].split("+", 1)[0]  # drop prerelease/build
    parts = core.split(".")
    try:
        nums = [int(p) for p in parts[:3]]
    except ValueError:
        return (-1, -1, -1)
    while len(nums) < 3:
        nums.append(0)
    return (nums[0], nums[1], nums[2])


class FileRegistry:
    """Read/write wrapper around ``registry.json``.

    All mutating methods persist immediately and atomically, so the on-disk file
    is always a consistent snapshot.
    """

    def __init__(self, registry_path: str | Path):
        self.path = Path(registry_path)
        self._data = self._load()

    # --- persistence ---------------------------------------------------------

    def _load(self) -> dict:
        if self.path.exists():
            data = json.loads(self.path.read_text(encoding="utf-8"))
            data.setdefault("registry_version", REGISTRY_VERSION)
            data.setdefault("models", [])
            return data
        return {"registry_version": REGISTRY_VERSION,
                "description": "Aaroh model registry; mirrors Postgres model_registry columns.",
                "models": []}

    def _flush(self) -> None:
        _atomic_write_json(self.path, self._data)

    # --- reads ---------------------------------------------------------------

    @property
    def models_dir(self) -> Path:
        """``models/`` — the parent of ``registry/``."""
        return self.path.parent.parent

    def records(self) -> list[ModelRecord]:
        return [ModelRecord.from_dict(m) for m in self._data["models"]]

    def get(self, version: str) -> ModelRecord | None:
        for m in self._data["models"]:
            if m["version"] == version:
                return ModelRecord.from_dict(m)
        return None

    def latest(self) -> ModelRecord | None:
        """Highest semantic version; ties broken by ``trained_at``."""
        recs = self.records()
        if not recs:
            return None
        return max(recs, key=lambda r: (_parse_semver(r.version), r.trained_at))

    def active(self) -> ModelRecord | None:
        for m in self._data["models"]:
            if m.get("is_active"):
                return ModelRecord.from_dict(m)
        return None

    def list_versions(self) -> list[str]:
        return [m["version"] for m in self._data["models"]]

    # --- writes --------------------------------------------------------------

    def register(self, record: ModelRecord, *, activate: bool = False,
                 overwrite: bool = False) -> ModelRecord:
        """Add (or replace) a record. Optionally make it the active model.

        Registering a duplicate version without ``overwrite`` is an error — a
        registry that silently clobbers frozen models is worse than useless.
        """
        existing_idx = next(
            (i for i, m in enumerate(self._data["models"]) if m["version"] == record.version),
            None,
        )
        if existing_idx is not None and not overwrite:
            raise ValueError(f"version '{record.version}' already registered; pass overwrite=True")

        if activate:
            record.is_active = True
        row = record.to_dict()
        if existing_idx is not None:
            self._data["models"][existing_idx] = row
        else:
            self._data["models"].append(row)

        if record.is_active:
            self._set_single_active(record.version)
        self._flush()
        return record

    def set_active(self, version: str) -> ModelRecord:
        if self.get(version) is None:
            raise KeyError(f"unknown version '{version}'")
        self._set_single_active(version)
        self._flush()
        return self.get(version)  # type: ignore[return-value]

    def _set_single_active(self, version: str) -> None:
        for m in self._data["models"]:
            m["is_active"] = (m["version"] == version)


def write_artifact_metadata(artifact_dir: str | Path, record: ModelRecord,
                            extra: dict | None = None) -> Path:
    """Drop a self-describing ``metadata.json`` beside the frozen model.

    So an artifact directory is interpretable on its own, even if separated from
    the registry index.
    """
    d = Path(artifact_dir)
    d.mkdir(parents=True, exist_ok=True)
    payload = record.to_dict()
    if extra:
        payload["extra"] = extra
    out = d / "metadata.json"
    _atomic_write_json(out, payload)
    return out

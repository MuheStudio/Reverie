"""Independent canonical-snapshot worldbook evaluator (repository GPL-3.0)."""

from .engine import (
    EvaluationResult,
    SnapshotValidationError,
    WorldbookEngine,
    WorldbookSnapshot,
    compile_snapshot,
)

__all__ = [
    "EvaluationResult", "SnapshotValidationError", "WorldbookEngine",
    "WorldbookSnapshot", "compile_snapshot",
]

"""Evidence chain + typed atoms + governance three-judgment tests (Phase 1C)."""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from src.memory.catalog import MemoryCatalog


@pytest.fixture()
def catalog(tmp_path: Path):
    cat = MemoryCatalog(tmp_path / "evidence_test.db")
    yield cat
    cat.close()


def _insert(catalog: MemoryCatalog, mid: str, text: str, **kw) -> None:
    catalog.upsert(
        id=mid,
        text=text,
        retention_layer=kw.get("layer", "long_term"),
        cognitive_layer=kw.get("cognitive", "episodic"),
        timestamp=kw.get("timestamp", time.time()),
        importance=kw.get("importance", 0.6),
        emotions=None,
        embedding_model_version="test:v1",
    )


# ── Evidence chain CRUD ──────────────────────────────────────────────


def test_add_and_get_evidence_ref(catalog: MemoryCatalog):
    _insert(catalog, "m1", "用户喜欢猫")
    _insert(catalog, "m2", "用户养了一只猫")
    ref_id = catalog.add_evidence_ref(
        memory_id="m1", relation="supports", target_id="m2", confidence=0.9
    )
    assert ref_id > 0
    refs = catalog.get_evidence_refs("m1")
    assert len(refs) == 1
    assert refs[0]["relation"] == "supports"
    assert refs[0]["target_id"] == "m2"
    assert refs[0]["confidence"] == pytest.approx(0.9)


def test_get_referencing(catalog: MemoryCatalog):
    _insert(catalog, "m1", "原始事实")
    _insert(catalog, "m2", "派生结论")
    catalog.add_evidence_ref(
        memory_id="m2", relation="derived_from", target_id="m1"
    )
    refs = catalog.get_referencing("m1")
    assert len(refs) == 1
    assert refs[0]["memory_id"] == "m2"
    assert refs[0]["relation"] == "derived_from"


def test_find_conflicts(catalog: MemoryCatalog):
    _insert(catalog, "m1", "用户养猫")
    _insert(catalog, "m2", "用户没有宠物")
    catalog.add_evidence_ref(
        memory_id="m1", relation="conflicts", target_id="m2", confidence=0.85
    )
    conflicts = catalog.find_conflicts("m1")
    assert len(conflicts) == 1
    assert conflicts[0]["target_id"] == "m2"
    # Also discoverable from the other side
    conflicts2 = catalog.find_conflicts("m2")
    assert len(conflicts2) == 1
    assert conflicts2[0]["memory_id"] == "m1"


def test_supersedes_chain(catalog: MemoryCatalog):
    _insert(catalog, "m1", "用户住在北京")
    _insert(catalog, "m2", "用户住在杭州")
    catalog.add_evidence_ref(
        memory_id="m2", relation="supersedes", target_id="m1"
    )
    refs = catalog.get_evidence_refs("m2")
    assert refs[0]["relation"] == "supersedes"
    assert refs[0]["target_id"] == "m1"


def test_invalid_relation_rejected(catalog: MemoryCatalog):
    _insert(catalog, "m1", "test")
    with pytest.raises(ValueError, match="Unsupported evidence relation"):
        catalog.add_evidence_ref(
            memory_id="m1", relation="invalid", target_id="m1"
        )


def test_confidence_clamped(catalog: MemoryCatalog):
    _insert(catalog, "m1", "a")
    _insert(catalog, "m2", "b")
    catalog.add_evidence_ref(
        memory_id="m1", relation="supports", target_id="m2", confidence=5.0
    )
    refs = catalog.get_evidence_refs("m1")
    assert refs[0]["confidence"] == pytest.approx(1.0)


# ── Typed atoms CRUD ─────────────────────────────────────────────────


def test_add_and_list_atom(catalog: MemoryCatalog):
    _insert(catalog, "m1", "用户喜欢吃火锅")
    atom_id = catalog.add_atom(
        memory_id="m1",
        atom_type="preference",
        subject="用户",
        predicate="喜欢吃",
        object="火锅",
        confidence=0.92,
        extraction_reason="explicit statement",
    )
    assert atom_id > 0
    atoms = catalog.list_atoms("m1")
    assert len(atoms) == 1
    assert atoms[0]["atom_type"] == "preference"
    assert atoms[0]["subject"] == "用户"
    assert atoms[0]["predicate"] == "喜欢吃"
    assert atoms[0]["object"] == "火锅"
    assert atoms[0]["review_status"] == "pending"


def test_list_atoms_by_type(catalog: MemoryCatalog):
    _insert(catalog, "m1", "test")
    catalog.add_atom(memory_id="m1", atom_type="preference", object="猫")
    catalog.add_atom(memory_id="m1", atom_type="promise", object="明天见")
    catalog.add_atom(memory_id="m1", atom_type="event", object="生日")

    prefs = catalog.list_atoms(atom_type="preference")
    assert len(prefs) == 1
    assert prefs[0]["object"] == "猫"

    all_atoms = catalog.list_atoms("m1")
    assert len(all_atoms) == 3


def test_update_atom_status(catalog: MemoryCatalog):
    _insert(catalog, "m1", "test")
    atom_id = catalog.add_atom(memory_id="m1", atom_type="lesson", object="不要熬夜")
    assert catalog.update_atom_status(atom_id, "approved")
    atoms = catalog.list_atoms("m1", review_status="approved")
    assert len(atoms) == 1
    assert atoms[0]["review_status"] == "approved"

    # Rejected atoms filtered out of approved query
    assert catalog.update_atom_status(atom_id, "rejected")
    atoms = catalog.list_atoms("m1", review_status="approved")
    assert len(atoms) == 0


def test_invalid_atom_type_rejected(catalog: MemoryCatalog):
    _insert(catalog, "m1", "test")
    with pytest.raises(ValueError, match="Unsupported atom type"):
        catalog.add_atom(memory_id="m1", atom_type="invalid_type", object="x")


def test_invalid_review_status_rejected(catalog: MemoryCatalog):
    _insert(catalog, "m1", "test")
    atom_id = catalog.add_atom(memory_id="m1", atom_type="event", object="x")
    with pytest.raises(ValueError, match="Invalid atom review status"):
        catalog.update_atom_status(atom_id, "garbage")


def test_atom_types_complete(catalog: MemoryCatalog):
    """All six companion-relevant atom types should be accepted."""
    _insert(catalog, "m1", "test")
    for atom_type in ("preference", "constraint", "promise", "event", "lesson", "temporal_fact"):
        atom_id = catalog.add_atom(memory_id="m1", atom_type=atom_type, object=atom_type)
        assert atom_id > 0
    atoms = catalog.list_atoms("m1")
    assert len(atoms) == 6


def test_atom_fields_truncated(catalog: MemoryCatalog):
    _insert(catalog, "m1", "test")
    long_text = "x" * 3000
    atom_id = catalog.add_atom(
        memory_id="m1",
        atom_type="preference",
        subject=long_text,
        predicate=long_text,
        object=long_text,
        extraction_reason=long_text,
    )
    atoms = catalog.list_atoms("m1")
    assert len(atoms[0]["subject"]) <= 500
    assert len(atoms[0]["predicate"]) <= 500
    assert len(atoms[0]["object"]) <= 2000
    assert len(atoms[0]["extraction_reason"]) <= 500


# ── Cascade: deleting a memory cleans up evidence + atoms ────────────


def test_cascade_delete_cleans_evidence_and_atoms(catalog: MemoryCatalog):
    _insert(catalog, "m1", "source memory")
    _insert(catalog, "m2", "derived memory")
    catalog.add_evidence_ref(memory_id="m2", relation="derived_from", target_id="m1")
    catalog.add_atom(memory_id="m1", atom_type="event", object="birthday")
    catalog.add_atom(memory_id="m2", atom_type="lesson", object="be kind")

    assert catalog.delete("m1")
    # Evidence referencing m1 as memory_id should be gone
    assert catalog.get_evidence_refs("m1") == []
    # Atoms for m1 should be gone
    assert catalog.list_atoms("m1") == []
    # m2's evidence (where m1 is target) should survive (no FK on target_id)
    refs = catalog.get_evidence_refs("m2")
    assert len(refs) == 1  # derived_from still exists
    # m2's atoms should survive
    assert len(catalog.list_atoms("m2")) == 1

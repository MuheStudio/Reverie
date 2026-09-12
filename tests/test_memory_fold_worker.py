"""Fold worker — persistent job queue tests (Phase 1D)."""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from src.memory.catalog import MemoryCatalog
from src.memory.fold_worker import FoldWorker, JOB_KINDS


@pytest.fixture()
def catalog(tmp_path: Path):
    cat = MemoryCatalog(tmp_path / "fold_test.db")
    yield cat
    cat.close()


@pytest.fixture()
def worker(catalog: MemoryCatalog):
    return FoldWorker(catalog._connection, catalog._lock)


# ── Enqueue ──────────────────────────────────────────────────────────


def test_enqueue_returns_job_id(worker: FoldWorker):
    job_id = worker.enqueue("reembed", {"model": "v2"})
    assert job_id is not None
    assert job_id.startswith("job_")


def test_enqueue_dedupe_key_idempotent(worker: FoldWorker):
    id1 = worker.enqueue("reembed", dedupe_key="batch-001")
    id2 = worker.enqueue("reembed", dedupe_key="batch-001")
    assert id1 is not None
    assert id2 is None  # dedupe hit


def test_enqueue_invalid_kind(worker: FoldWorker):
    with pytest.raises(ValueError, match="Unsupported job kind"):
        worker.enqueue("invalid_kind")


def test_all_job_kinds_accepted(worker: FoldWorker):
    for kind in JOB_KINDS:
        job_id = worker.enqueue(kind, dedupe_key=f"test-{kind}")
        assert job_id is not None


# ── Claim ────────────────────────────────────────────────────────────


def test_claim_returns_oldest_pending(worker: FoldWorker):
    worker.enqueue("reembed", {"batch": 1}, dedupe_key="a")
    time.sleep(0.01)
    worker.enqueue("reembed", {"batch": 2}, dedupe_key="b")

    job = worker.claim_job()
    assert job is not None
    assert job["status"] == "running"
    assert job["payload"]["batch"] == 1
    assert job["attempts"] == 1


def test_claim_by_kind(worker: FoldWorker):
    worker.enqueue("reembed", dedupe_key="r1")
    worker.enqueue("extract_atoms", dedupe_key="e1")

    job = worker.claim_job(kind="extract_atoms")
    assert job is not None
    assert job["kind"] == "extract_atoms"


def test_claim_returns_none_when_empty(worker: FoldWorker):
    assert worker.claim_job() is None


def test_claim_skips_running_jobs(worker: FoldWorker):
    worker.enqueue("reembed", dedupe_key="only")
    job = worker.claim_job()  # claims it
    assert job is not None
    # No more jobs available
    assert worker.claim_job() is None


# ── Complete ─────────────────────────────────────────────────────────


def test_complete_job(worker: FoldWorker):
    worker.enqueue("reembed", dedupe_key="c1")
    job = worker.claim_job()
    assert worker.complete_job(job["id"], checkpoint={"done": True})

    jobs = worker.list_jobs(status="completed")
    assert len(jobs) == 1
    assert jobs[0]["id"] == job["id"]


def test_complete_non_running_fails(worker: FoldWorker):
    worker.enqueue("reembed", dedupe_key="c2")
    jobs = worker.list_jobs(status="pending")
    # Try to complete a pending job (not claimed)
    assert not worker.complete_job(jobs[0]["id"])


# ── Fail + retry ─────────────────────────────────────────────────────


def test_fail_job_returns_to_pending(worker: FoldWorker):
    worker.enqueue("reembed", dedupe_key="f1", max_attempts=3)
    job = worker.claim_job()
    assert worker.fail_job(job["id"], checkpoint={"progress": 50})

    # Job should be back to pending (attempt 1 of 3)
    jobs = worker.list_jobs(status="pending")
    assert len(jobs) == 1


def test_fail_job_max_attempts_marks_failed(worker: FoldWorker):
    worker.enqueue("reembed", dedupe_key="f2", max_attempts=1)
    job = worker.claim_job()  # attempt 1
    assert worker.fail_job(job["id"])

    # Should be permanently failed
    jobs = worker.list_jobs(status="failed")
    assert len(jobs) == 1
    # Cannot be reclaimed
    assert worker.claim_job() is None


def test_checkpoint_survives_failure(worker: FoldWorker):
    worker.enqueue("reembed", dedupe_key="cp1", max_attempts=3)
    job = worker.claim_job()
    worker.fail_job(job["id"], checkpoint={"offset": 42})

    # Reclaim — checkpoint should be available
    job2 = worker.claim_job()
    assert job2 is not None
    assert job2["checkpoint"]["offset"] == 42


# ── Lease expiry ─────────────────────────────────────────────────────


def test_expired_lease_reclaimable(worker: FoldWorker):
    worker.enqueue("reembed", dedupe_key="le1")
    # Claim with a very short lease; we'll monkey-patch lease_until to the past
    job = worker.claim_job(lease_seconds=300)
    assert job is not None

    # Force-expire the lease by backdating lease_until
    with worker._lock:
        worker._conn.execute(
            "UPDATE memory_jobs SET lease_until=? WHERE id=?",
            (time.time() - 10, job["id"]),
        )

    # Another claim should reclaim the expired job
    job2 = worker.claim_job()
    assert job2 is not None
    assert job2["id"] == job["id"]
    assert job2["attempts"] == 2


# ── List ─────────────────────────────────────────────────────────────


def test_list_jobs_filters(worker: FoldWorker):
    worker.enqueue("reembed", dedupe_key="l1")
    worker.enqueue("extract_atoms", dedupe_key="l2")
    job = worker.claim_job(kind="reembed")
    worker.complete_job(job["id"])

    assert len(worker.list_jobs(status="completed")) == 1
    assert len(worker.list_jobs(status="pending")) == 1
    assert len(worker.list_jobs(kind="reembed")) == 1
    assert len(worker.list_jobs(kind="extract_atoms")) == 1
    assert len(worker.list_jobs()) == 2


# ── process_batch ────────────────────────────────────────────────────


def test_process_batch(worker: FoldWorker):
    for i in range(3):
        worker.enqueue("reembed", dedupe_key=f"pb-{i}")

    processed = worker.process_batch(limit=5)
    # After P1D wiring, reembed jobs are processed (gracefully no-op without catalog)
    assert processed == 3
    assert len(worker.list_jobs(status="pending")) == 0
    assert len(worker.list_jobs(status="completed")) == 3


def test_process_batch_empty(worker: FoldWorker):
    assert worker.process_batch() == 0

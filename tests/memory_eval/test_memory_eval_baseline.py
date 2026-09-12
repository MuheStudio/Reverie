"""Memory evaluation baseline runner — offline retrieval quality benchmarks.

Runs 30 badcase fixtures against MemoryCatalog's keyword-based retrieval
(candidate_rows + permanent_candidates) and reports hit/miss statistics.

This is a pure offline test — no LLM calls, no embeddings, only keyword matching.
"""

from __future__ import annotations

import json
import sys

import pytest

from tests.memory_eval.badcase_fixtures import ALL_FIXTURES, CATEGORIES
from tests.memory_eval.conftest import retrieve_texts, seed_catalog

from src.memory.catalog import MemoryCatalog


def _check_fixture(catalog: MemoryCatalog, fixture: dict) -> dict:
    """Evaluate one fixture; return a result dict."""

    query = fixture["query"]
    expect_hit = fixture.get("expect_hit", [])
    expect_miss = fixture.get("expect_miss", [])
    expect_top_order = fixture.get("expect_top_order", [])

    texts = retrieve_texts(catalog, query, limit=10)
    joined = " ".join(texts)

    hits_found = [kw for kw in expect_hit if kw in joined]
    hits_missing = [kw for kw in expect_hit if kw not in joined]
    miss_violations = [kw for kw in expect_miss if kw in joined]

    # Top-order check: first expected keyword should appear in the first result
    top_ok = True
    if expect_top_order and texts:
        top_ok = any(kw in texts[0] for kw in expect_top_order)

    passed = (
        len(hits_missing) == 0
        and len(miss_violations) == 0
        and top_ok
    )

    return {
        "id": fixture["id"],
        "category": fixture["category"],
        "label": fixture["label"],
        "passed": passed,
        "hits_found": hits_found,
        "hits_missing": hits_missing,
        "miss_violations": miss_violations,
        "top_ok": top_ok,
        "retrieved_count": len(texts),
        "first_result": texts[0][:120] if texts else "(empty)",
    }


class TestMemoryEvalBaseline:
    """Parametrized baseline evaluation across all 30 badcase fixtures."""

    @pytest.fixture(autouse=True)
    def _setup(self, catalog_factory):
        self._catalog_factory = catalog_factory

    @pytest.mark.parametrize(
        "fixture",
        ALL_FIXTURES,
        ids=[f["id"] for f in ALL_FIXTURES],
    )
    def test_badcase(self, fixture: dict) -> None:
        catalog = self._catalog_factory()
        seed_catalog(catalog, fixture["seed_memories"])
        result = _check_fixture(catalog, fixture)

        # Soft assertion: log details even on failure
        if not result["passed"]:
            # Known baseline gaps are expected failures — mark as xfail
            if fixture.get("known_baseline_gap"):
                pytest.xfail(
                    f"[{result['id']}] Known baseline gap: {result['label']}"
                )
            detail = (
                f"[{result['id']}] {result['label']}\n"
                f"  hits_missing={result['hits_missing']}\n"
                f"  miss_violations={result['miss_violations']}\n"
                f"  top_ok={result['top_ok']}\n"
                f"  first_result={result['first_result']}"
            )
            pytest.fail(detail, pytrace=False)


def run_full_report(tmp_path_str: str | None = None) -> dict:
    """Run all fixtures and return a JSON-serializable report."""

    import tempfile
    from pathlib import Path

    base = Path(tmp_path_str) if tmp_path_str else Path(tempfile.mkdtemp())
    results = []
    by_category: dict[str, dict] = {}

    for i, fixture in enumerate(ALL_FIXTURES):
        db_path = base / f"eval_{i}.db"
        catalog = MemoryCatalog(db_path)
        try:
            seed_catalog(catalog, fixture["seed_memories"])
            result = _check_fixture(catalog, fixture)
            results.append(result)

            cat = fixture["category"]
            if cat not in by_category:
                by_category[cat] = {"total": 0, "passed": 0}
            by_category[cat]["total"] += 1
            if result["passed"]:
                by_category[cat]["passed"] += 1
        finally:
            catalog.close()

    total = len(results)
    passed = sum(1 for r in results if r["passed"])

    report = {
        "total": total,
        "passed": passed,
        "failed": total - passed,
        "pass_rate": f"{passed / total * 100:.1f}%" if total else "N/A",
        "by_category": {
            cat: {
                "label": CATEGORIES.get(cat, cat),
                "total": stats["total"],
                "passed": stats["passed"],
                "rate": f"{stats['passed'] / stats['total'] * 100:.1f}%"
                if stats["total"] else "N/A",
            }
            for cat, stats in by_category.items()
        },
        "details": results,
    }
    return report


if __name__ == "__main__":
    report = run_full_report()
    print(json.dumps(report, ensure_ascii=False, indent=2))
    sys.exit(0 if report["failed"] == 0 else 1)

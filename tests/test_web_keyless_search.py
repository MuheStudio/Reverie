"""Keyless search engines, orchestrator and evidence anchoring (批1-3).

All engine tests run against httpx.MockTransport fixtures — no real network.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import httpx
import pytest

from src.web.evidence import (
    build_evidence,
    fetch_page_text,
    split_passages,
    stable_citation_id,
    strip_orphan_citations,
)
from src.web.search_engines import (
    ArxivSearchEngine,
    DdgsSerpEngine,
    HnAlgoliaSearchEngine,
    RawHit,
    SearchEngineError,
    StackExchangeSearchEngine,
    WikipediaSearchEngine,
    build_topic_query,
)
from src.web.search_orchestrator import (
    CircuitBreaker,
    SearchOrchestrator,
    consensus_multiplier,
    normalize_url,
    parse_published_at,
    recency_multiplier,
)

HONEST_UA = "Reverie-local/1.0 (local companion app)"


def _client(handler) -> httpx.AsyncClient:
    # Mirror production: the honest UA rides on the client, not the engine.
    return httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        follow_redirects=False,
        headers={"User-Agent": HONEST_UA},
    )


# ── Engines ───────────────────────────────────────────────────────────────


async def test_wikipedia_engine_parses_fixture():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["ua"] = request.headers.get("user-agent", "")
        captured["params"] = dict(request.url.params)
        return httpx.Response(200, json={"query": {"search": [
            {"title": "原神", "snippet": "<b>米哈游</b> 开发的游戏"},
            {"title": "", "snippet": "skipped: empty title"},
        ]}})

    hits = await WikipediaSearchEngine(lang="zh").search("游戏 版本 更新", client=_client(handler))
    assert captured["ua"] == HONEST_UA
    assert captured["params"]["srsearch"] == "游戏 版本 更新"
    assert len(hits) == 1
    assert hits[0].title == "原神"
    assert hits[0].url.startswith("https://zh.wikipedia.org/wiki/")
    assert "<b>" not in hits[0].snippet


async def test_stackexchange_engine_parses_fixture():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers.get("user-agent") == HONEST_UA
        return httpx.Response(200, json={"items": [
            {"title": "How to use &amp; in httpx?", "link": "https://stackoverflow.com/q/1",
             "score": 15, "creation_date": 1780000000},
        ]})

    hits = await StackExchangeSearchEngine().search("httpx", client=_client(handler))
    assert len(hits) == 1
    assert hits[0].title == "How to use & in httpx?"
    assert hits[0].url == "https://stackoverflow.com/q/1"
    assert hits[0].relevance == pytest.approx(0.15)


async def test_engine_block_classification():
    def handler_for(status: int):
        return lambda request: httpx.Response(status, text="no")

    for status, blocked, transient in [(403, True, False), (503, True, False), (429, True, True)]:
        with pytest.raises(SearchEngineError) as exc_info:
            await HnAlgoliaSearchEngine().search("x", client=_client(handler_for(status)))
        assert exc_info.value.blocked is blocked
        assert exc_info.value.transient is transient


async def test_hn_engine_object_id_fallback():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"hits": [
            {"title": "Show HN", "url": "", "objectID": "abc123", "points": 42, "created_at": "2026-01-01"},
            {"title": "", "url": "https://x.example", "objectID": "9"},
        ]})

    hits = await HnAlgoliaSearchEngine().search("electron", client=_client(handler))
    assert len(hits) == 1
    assert hits[0].url == "https://news.ycombinator.com/item?id=abc123"
    assert hits[0].relevance == pytest.approx(42 / 200.0)


async def test_arxiv_engine_rejects_dtd():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text='<!DOCTYPE foo SYSTEM "x.dtd"><feed/>')

    with pytest.raises(SearchEngineError):
        await ArxivSearchEngine().search("electron", client=_client(handler))


async def test_ddgs_engine_success_and_ratelimit():
    rows = [
        {"title": "原神版本", "href": "https://example.com/a", "body": "新版本上线", "date": "2026-09-01"},
        {"title": "no url", "href": "javascript:void(0)", "body": "skipped"},
    ]
    engine = DdgsSerpEngine("bing", text_fn=lambda q, **kw: rows)
    assert engine.name == "ddgs-bing"
    hits = await engine.search("原神", client=None)
    assert len(hits) == 1
    assert hits[0].title == "原神版本"
    assert hits[0].engine == "ddgs-bing"

    def limited(q, **kw):
        raise RuntimeError("202 Ratelimit hit")

    with pytest.raises(SearchEngineError) as exc_info:
        await DdgsSerpEngine("bing", text_fn=limited).search("x", client=None)
    assert exc_info.value.transient is True and exc_info.value.blocked is True


def test_ddgs_backend_name_validation():
    with pytest.raises(ValueError):
        DdgsSerpEngine("../evil")
    with pytest.raises(ValueError):
        DdgsSerpEngine(["bing", "../evil"])
    with pytest.raises(ValueError):
        DdgsSerpEngine([])


async def test_ddgs_chain_falls_over_to_next_backend_on_block():
    # DuckDuckGo is blocked (2026: CAPTCHA / ddgs #480 403); the chain must
    # transparently fall over to the next backend and still return results.
    calls: list[str] = []

    def text_fn(query, *, region, backend, max_results):
        calls.append(backend)
        if backend == "duckduckgo":
            raise RuntimeError("403 Forbidden")
        if backend == "bing":
            return [{"title": "命中", "href": "https://example.com/x", "body": "内容"}]
        return []

    engine = DdgsSerpEngine(["duckduckgo", "bing", "mojeek"], text_fn=text_fn)
    assert engine.name == "ddgs-serp"
    hits = await engine.search("原神", client=None)
    assert len(hits) == 1
    assert hits[0].engine == "ddgs-serp"
    # It tried duckduckgo first, then bing; it must NOT waste a call on mojeek
    # once bing produced results.
    assert calls == ["duckduckgo", "bing"]


async def test_ddgs_chain_one_backend_error_never_discards_later_results():
    # Guard against ddgs #427: a backend that raises first must not wipe out a
    # later backend's successful results.
    def text_fn(query, *, region, backend, max_results):
        if backend == "bing":
            raise RuntimeError("boom")
        return [{"title": "ok", "href": "https://example.com/ok", "body": "b"}]

    engine = DdgsSerpEngine(["bing", "duckduckgo"], text_fn=text_fn)
    hits = await engine.search("q", client=None)
    assert [h.url for h in hits] == ["https://example.com/ok"]


def test_ddgs_registered_chain_puts_reliable_backends_first() -> None:
    """P1-5: the production SERP chain must prefer reliable backends.

    DuckDuckGo is CAPTCHA-prone in 2026 (ddgs #480); it must sit at the tail
    so bing → mojeek are tried first. A future reorder back to
    ["bing","duckduckgo","mojeek"] would make the common 403 path slower."""
    from src.web import WebSurfingManager
    from src.persona.persona_card import default_persona

    import tempfile
    from pathlib import Path

    manager = WebSurfingManager(default_persona(), data_dir=Path(tempfile.mkdtemp()))
    orch = manager._ensure_search_orchestrator()
    serp = next(e for e in orch.engines if getattr(e, "backends", None))
    assert serp.backends[0] == "bing"
    assert serp.backends[1] == "mojeek"
    assert serp.backends[-1] == "duckduckgo"


async def test_ddgs_chain_all_backends_blocked_preserves_transient_signal():
    # A ratelimit on any backend must keep the aggregate error transient+blocked
    # so the breaker cools down briefly instead of tripping a chronic outage.
    def text_fn(query, *, region, backend, max_results):
        if backend == "bing":
            raise RuntimeError("202 Ratelimit hit")
        raise RuntimeError("403 Forbidden")

    with pytest.raises(SearchEngineError) as exc_info:
        await DdgsSerpEngine(["bing", "duckduckgo"], text_fn=text_fn).search("q", client=None)
    assert exc_info.value.blocked is True
    assert exc_info.value.transient is True


async def test_ddgs_chain_all_empty_returns_empty_not_error():
    def text_fn(query, *, region, backend, max_results):
        return []

    hits = await DdgsSerpEngine(["bing", "duckduckgo"], text_fn=text_fn).search("q", client=None)
    assert hits == []


def test_build_topic_query_privacy():
    assert build_topic_query("游戏更新") == "游戏 版本 更新"
    assert build_topic_query("未知话题") == "未知话题"  # caller pre-filters SAFE_TOPICS
    assert build_topic_query("") == ""
    # The builder never appends context: only the topic-derived term leaves.
    assert "用户" not in build_topic_query("热门梗")


# ── URL normalization ─────────────────────────────────────────────────────


def test_normalize_url_strips_tracking_and_sorts():
    a = normalize_url("HTTPS://News.Example.com/a/?utm_source=x&b=2&a=1&fbclid=z#frag")
    b = normalize_url("https://news.example.com/a?a=1&b=2")
    assert a == b
    assert "utm_source" not in a
    assert normalize_url("https://x.com:443/p") == "https://x.com/p"
    assert normalize_url("notaurl") == ""


# ── Circuit breaker ───────────────────────────────────────────────────────


def test_breaker_chronic_trips_and_resets():
    breaker = CircuitBreaker()
    now = 1000.0
    for _ in range(3):
        assert breaker.allow("bing", now=now)
        breaker.record_failure("bing", now=now)
    assert not breaker.allow("bing", now=now + 1)
    assert breaker.allow("bing", now=now + 60.1)  # first trip: 60s cooldown
    breaker.record_failure("bing", now=now + 61)
    breaker.record_failure("bing", now=now + 62)
    # Next trip doubles the cooldown (capped later at 180s).
    assert not breaker.allow("bing", now=now + 62.5)
    assert breaker.allow("bing", now=now + 62.5 + 121)
    breaker.record_success("bing")
    assert breaker.allow("bing", now=now + 200)
    assert breaker.snapshot()["bing"]["failures"] == 0


def test_breaker_transient_never_climbs_chronic_ladder():
    breaker = CircuitBreaker()
    now = 0.0
    breaker.record_failure("ddg", transient=True, now=now)
    assert not breaker.allow("ddg", now=now + 4.9)
    assert breaker.allow("ddg", now=now + 5.1)  # a single 429 cools down in ~5s
    for _ in range(4):
        breaker.record_failure("ddg", transient=True, now=now)
    snapshot = breaker.snapshot()["ddg"]
    assert snapshot["failures"] == 0  # transient trips never count toward chronic
    assert breaker.allow("ddg", now=now + 31)  # repeated 429 escalation caps at 30s


# ── Orchestrator ──────────────────────────────────────────────────────────


class _FakeEngine:
    def __init__(self, name: str, payload):
        self.name = name
        self._payload = payload

    async def search(self, query, *, client=None):
        payload = self._payload
        if isinstance(payload, float):  # simulate a slow engine
            await asyncio.sleep(payload)
            return []
        if isinstance(payload, Exception):
            raise payload
        return payload


async def test_orchestrator_fuses_and_dedups():
    hit_a = RawHit(title="A", url="https://x.example/p?utm_source=t", snippet="s", engine="e1")
    hit_b = RawHit(title="B", url="https://x.example/p", snippet="s2", engine="e2")
    engine1 = _FakeEngine("e1", [hit_a, RawHit(title="C", url="https://y.example", snippet="", engine="e1")])
    engine2 = _FakeEngine("e2", [hit_b])
    orchestrator = SearchOrchestrator([engine1, engine2], quality={"e1": 1.0, "e2": 1.0})
    result = await orchestrator.search("q")
    assert result.states == {"e1": "ok", "e2": "ok"}
    urls = [hit.url for hit in result.hits]
    assert len(urls) == len(set(normalize_url(url) for url in urls))
    # The URL seen by both engines must fuse to the top; each engine's own
    # rank for it is 1, so the base RRF score is 2 * 1/(60+1). It is returned by
    # two distinct engines, so the consensus multiplier (1 + 0.1) applies; the
    # hit is undated so recency leaves it unchanged.
    top = result.hits[0]
    assert normalize_url(top.url) == "https://x.example/p"
    assert top.relevance == pytest.approx(2.0 / 61 * 1.1)


async def test_orchestrator_reports_blocked_not_empty():
    engine_ok = _FakeEngine("ok", [])
    engine_blocked = _FakeEngine("blocked", SearchEngineError("403", blocked=True))
    engine_transient = _FakeEngine("flaky", SearchEngineError("429", blocked=True, transient=True))
    result = await SearchOrchestrator([engine_ok, engine_blocked, engine_transient]).search("q")
    assert result.states == {"ok": "empty", "blocked": "blocked", "flaky": "transient"}


async def test_orchestrator_soft_deadline_drops_slow_engine():
    fast = _FakeEngine("fast", [RawHit(title="F", url="https://f.example", snippet="", engine="fast")])
    slow = _FakeEngine("slow", 10.0)
    result = await SearchOrchestrator([fast, slow]).search(
        "q", slow_deadline=0.05, soft_deadline=0.2, max_hits=5
    )
    assert result.states["slow"] == "timeout"
    assert result.states["fast"] == "ok"
    assert len(result.hits) == 1


async def test_orchestrator_skips_open_breaker():
    breaker = CircuitBreaker()
    breaker.record_failure("down", now=0.0)
    breaker.record_failure("down", now=0.0)
    breaker.record_failure("down", now=0.0)
    engine = _FakeEngine("down", [RawHit(title="x", url="https://x.example", snippet="", engine="down")])
    result = await SearchOrchestrator([engine], breaker=breaker).search("q", now=1.0)
    assert result.states == {"down": "skipped"}
    assert result.hits == []


# ── 补砖②: recency demotion + consensus boost ─────────────────────────────


def test_parse_published_at_handles_heterogeneous_shapes():
    assert parse_published_at("") is None
    assert parse_published_at("garbage") is None
    # Unix epoch (StackExchange), ISO/Atom (HN/arXiv), free-form date (ddgs).
    assert parse_published_at("1704067200").year == 2024
    assert parse_published_at("2026-09-01T12:00:00Z").year == 2026
    assert parse_published_at("Published 2026-09-01").month == 9


def test_recency_multiplier_demotes_only_stale_dated_pages():
    now = datetime(2026, 9, 8, tzinfo=timezone.utc)
    # Undated → never touched.
    assert recency_multiplier(None, now) == 1.0
    # Within the 14-day grace window → fresh.
    assert recency_multiplier(datetime(2026, 9, 1, tzinfo=timezone.utc), now) == 1.0
    # Old → demoted below 1.0 but never under the floor.
    old = recency_multiplier(datetime(2025, 1, 1, tzinfo=timezone.utc), now)
    assert 0.25 <= old < 1.0
    # Future/clock-skew → not boosted.
    assert recency_multiplier(datetime(2027, 1, 1, tzinfo=timezone.utc), now) == 1.0


def test_consensus_multiplier_rewards_distinct_engine_agreement():
    assert consensus_multiplier(1) == 1.0
    assert consensus_multiplier(2) == pytest.approx(1.1)
    assert consensus_multiplier(3) == pytest.approx(1.2)
    # Capped so one popular URL can't dominate.
    assert consensus_multiplier(50) == pytest.approx(1.3)


async def test_orchestrator_demotes_stale_result_below_fresh_one():
    now = datetime(2026, 9, 8, tzinfo=timezone.utc)
    fresh = RawHit(title="fresh", url="https://a.example", snippet="", engine="e1",
                   published_at="2026-09-05")
    stale = RawHit(title="stale", url="https://b.example", snippet="", engine="e1",
                   published_at="2023-01-01")
    # Same engine, so stale is returned first (rank 1, higher base RRF). Recency
    # demotion must still push the fresh page above the stale one.
    engine = _FakeEngine("e1", [stale, fresh])
    result = await SearchOrchestrator([engine], quality={"e1": 1.0}).search("q", now_utc=now)
    assert [h.title for h in result.hits] == ["fresh", "stale"]


async def test_orchestrator_consensus_lifts_multi_engine_url():
    now = datetime(2026, 9, 8, tzinfo=timezone.utc)
    # Solo URL ranks first on both engines (base 1/61 each); shared URL ranks
    # second on both (base 1/62 each) but is lifted by the consensus multiplier.
    e1 = _FakeEngine("e1", [
        RawHit(title="solo1", url="https://solo1.example", snippet="", engine="e1"),
        RawHit(title="shared", url="https://shared.example", snippet="", engine="e1"),
    ])
    e2 = _FakeEngine("e2", [
        RawHit(title="solo2", url="https://solo2.example", snippet="", engine="e2"),
        RawHit(title="shared", url="https://shared.example", snippet="", engine="e2"),
    ])
    result = await SearchOrchestrator([e1, e2], quality={"e1": 1.0, "e2": 1.0}).search(
        "q", now_utc=now
    )
    top = result.hits[0]
    assert normalize_url(top.url) == normalize_url("https://shared.example")


# ── Evidence ──────────────────────────────────────────────────────────────


def test_split_passages_anchor_verbatim_slices():
    text = "第一段开头。" + "长" * 40 + "\n\n" + "第二段也有足够长度" * 4 + "\n\n短"
    passages = split_passages(text)
    assert len(passages) == 2
    for passage in passages:
        assert text[passage.char_start:passage.char_end] == passage.text


def test_citation_id_stable_and_distinct():
    assert stable_citation_id("https://x.example", 10) == stable_citation_id("https://x.example", 10)
    assert stable_citation_id("https://x.example", 10) != stable_citation_id("https://x.example", 20)
    assert len(stable_citation_id("https://x.example", 0)) == 12


def test_strip_orphan_citations():
    text = "她说了[1]这句话，又提到[2]和[9]以及[0]。"
    assert strip_orphan_citations(text, 2) == "她说了[1]这句话，又提到[2]和以及。"
    assert strip_orphan_citations(text, 0) == "她说了这句话，又提到和以及。"


def test_build_evidence_prefers_query_relevant_passages():
    page = "无关的开场白" * 10 + "\n\n" + "《夏日重现》第二季宣布制作决定。" * 5 + "\n\n" + "另外一段普通内容也写得很长很长很长。"
    evidence = build_evidence(page, "https://anime.example/post", query_terms=["夏日重现"])
    assert evidence
    assert "夏日重现" in evidence[0]["excerpt"]
    entry = evidence[0]
    assert page[entry["char_start"]:entry["char_end"]] == entry["excerpt"]


async def test_fetch_page_text_extracts_and_blocks_private_urls(monkeypatch):
    import src.web as web_pkg

    async def allow_all(url: str) -> bool:
        return str(url).startswith("https://")

    monkeypatch.setattr(web_pkg, "_is_public_https_url", allow_all)

    html = (
        "<html><body><nav>导航导航</nav><article><h1>标题</h1>"
        "<p>" + "正文内容足够长可以成为段落。" * 6 + "</p></article></body></html>"
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=html, headers={"content-type": "text/html"})

    text = await fetch_page_text("https://public.example/post", client=_client(handler))
    # Boilerplate quality is trafilatura's domain (benchmarked upstream); here
    # we assert extraction works and returns the main content.
    assert text and "正文内容足够长" in text

    assert await fetch_page_text("http://127.0.0.1/secret", client=_client(handler)) is None


async def test_settings_flag_default_off_and_manager_gate():
    from pathlib import Path
    import tempfile

    from src.config.settings import FeatureSettings
    from src.web import WebSurfingManager

    assert FeatureSettings().surf_keyless_search_enabled is False

    with tempfile.TemporaryDirectory() as tmp:
        manager = WebSurfingManager(data_dir=Path(tmp), keyless_search_enabled=False)
        assert manager.keyless_search_enabled is False
        # With the flag off, the third source must never even be attempted.
        assert await manager._fetch_via_keyless_search() is False


async def test_fetch_requires_surfing_consent_not_model_api_grant():
    from pathlib import Path
    import tempfile
    from datetime import datetime

    from src.web import WebSurfingManager

    class _DeniedPolicy:
        def allowed(self, feature: str) -> bool:
            return False

    with tempfile.TemporaryDirectory() as tmp:
        manager = WebSurfingManager(
            data_dir=Path(tmp),
            keyless_search_enabled=True,
            usage_policy=_DeniedPolicy(),
            surfing_consent=False,
            search_windows=["00:00-23:59"],
        )
        manager._now_local = lambda: datetime(2026, 7, 4, 21, 0)
        assert await manager.fetch_if_needed() is False
        manager.surfing_consent = True
        # Consent is on, but there is still no local/RSS/search content in this
        # empty cache — the call must not raise, and must not treat missing
        # web_access grant as a hard skip anymore.
        refreshed = await manager.fetch_if_needed()
        assert refreshed is False

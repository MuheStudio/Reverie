"""Keyless search engines for the surfing system (requirements #67-68).

Clean-room design per ``待实施计划/联网搜索新灵感/Reverie借鉴计划.md``:
concepts only, no code from any AGPL project.

Two engine families:

* SERP family — backed by the MIT-licensed ``ddgs`` library (optional). That
  library manages its own outbound identity (TLS impersonation); disclosed in
  ``CREDITS.md``. Failure to import it simply disables the family.
* Public-API family — plain httpx with the honest UA ``Reverie-local/1.x``.
  stackexchange and hn-algolia are reachable on typical networks; wikipedia
  and arxiv are best-effort (they are unreachable on some networks and rely
  on the orchestrator's circuit breaker to stay out of the way).

Every engine reports exactly one of three outcomes: ``ok`` (hits returned),
``empty`` (successful query, zero hits) or raises :class:`SearchEngineError`
with ``blocked``/``transient`` flags. A network block must never surface as
"no results" — the orchestrator feeds the distinction to its breaker.

Privacy red line: query construction accepts only whitelisted surf topics.
User names, memories, and diary content must never reach a query string.
"""

from __future__ import annotations

import asyncio
import logging
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from typing import Any, Callable

import httpx

logger = logging.getLogger("reverie.web.search")

HONEST_USER_AGENT = "Reverie-local/1.0 (local companion app)"
DEFAULT_SEARCH_TIMEOUT_SECONDS = 10.0
BEST_EFFORT_TIMEOUT_SECONDS = 6.0
MAX_RESULTS_PER_ENGINE = 8

#: Fixed query dictionary per whitelisted surf topic. Only these terms (or a
#: topic string already validated against SAFE_TOPICS by the caller) may be
#: sent to a search engine.
TOPIC_QUERIES: dict[str, str] = {
    "热门梗": "网络热梗 流行梗",
    "新番/动漫资讯": "新番 动画 资讯",
    "二次元内容": "二次元 动漫 动态",
    "游戏更新": "游戏 版本 更新",
    "科技趣闻": "科技 趣闻 新闻",
    "猫咪/宠物": "猫咪 宠物 趣闻",
    "美食/料理": "美食 料理 做法新闻",
}


def build_topic_query(topic: str) -> str:
    """Map a whitelisted topic to a fixed search query.

    Unknown topics degrade to the topic text itself; the caller is expected to
    have already filtered topics against ``SAFE_TOPICS``.
    """
    cleaned = re.sub(r"\s+", " ", str(topic or "")).strip()[:60]
    if not cleaned:
        return ""
    return TOPIC_QUERIES.get(cleaned, cleaned)


@dataclass(frozen=True)
class RawHit:
    """One search result, pre-sanitization. Never enters a prompt directly."""

    title: str
    url: str
    snippet: str
    engine: str
    published_at: str = ""
    relevance: float = 0.0


class SearchEngineError(Exception):
    """Engine failure with breaker hints.

    ``blocked=True`` marks an anti-bot style refusal (403/202/503); a
    ``transient`` failure (429-style rate limit) cools down fast and never
    climbs the chronic failure ladder.
    """

    def __init__(self, message: str, *, blocked: bool = False, transient: bool = False) -> None:
        super().__init__(message)
        self.blocked = blocked
        self.transient = transient


def _httpx_error(exc: Exception) -> SearchEngineError:
    """Classify an httpx/HTTP failure into the breaker taxonomy."""
    status = getattr(getattr(exc, "response", None), "status_code", None)
    if status == 429:
        return SearchEngineError(f"rate limited (HTTP 429)", blocked=True, transient=True)
    if status in {403, 503} or status == 202:
        return SearchEngineError(f"blocked (HTTP {status})", blocked=True)
    if isinstance(exc, (httpx.TimeoutException, asyncio.TimeoutError, TimeoutError)):
        return SearchEngineError("timeout")
    if isinstance(exc, httpx.HTTPStatusError):
        return SearchEngineError(f"HTTP {status}", blocked=status in {403, 503})
    return SearchEngineError(f"{exc.__class__.__name__}: {exc}" if str(exc) else exc.__class__.__name__)


def _strip_tags(value: str, limit: int = 300) -> str:
    text = re.sub(r"<[^>]+>", " ", str(value or ""))
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit]


async def _get_json(
    client: httpx.AsyncClient,
    url: str,
    *,
    params: dict[str, Any] | None = None,
    timeout: float = DEFAULT_SEARCH_TIMEOUT_SECONDS,
) -> Any:
    try:
        response = await client.get(url, params=params, timeout=timeout)
        response.raise_for_status()
        return response.json()
    except SearchEngineError:
        raise
    except Exception as exc:  # noqa: BLE001 - classified below
        raise _httpx_error(exc) from exc


# ── Public-API family (honest UA, no scraping of HTML search pages) ─────


class WikipediaSearchEngine:
    """MediaWiki search API. Best-effort: unreachable on some networks."""

    name = "wikipedia"
    family = "api"

    def __init__(self, lang: str = "zh") -> None:
        self.lang = re.sub(r"[^a-z-]", "", str(lang or "zh").lower())[:8] or "zh"
        self.timeout = BEST_EFFORT_TIMEOUT_SECONDS

    async def search(self, query: str, *, client: httpx.AsyncClient | None = None) -> list[RawHit]:
        assert client is not None, "API engines require an httpx client"
        text = str(query or "").strip()
        if not text:
            return []
        data = await _get_json(
            client,
            f"https://{self.lang}.wikipedia.org/w/api.php",
            params={
                "action": "query",
                "list": "search",
                "srsearch": text[:300],
                "format": "json",
                "srlimit": MAX_RESULTS_PER_ENGINE,
            },
            timeout=self.timeout,
        )
        hits: list[RawHit] = []
        for entry in (data.get("query", {}) or {}).get("search", [])[:MAX_RESULTS_PER_ENGINE]:
            if not isinstance(entry, dict):
                continue
            title = _strip_tags(str(entry.get("title", "")), 200)
            if not title:
                continue
            hits.append(RawHit(
                title=title,
                url=f"https://{self.lang}.wikipedia.org/wiki/{title.replace(' ', '_')}",
                snippet=_strip_tags(str(entry.get("snippet", "")), 400),
                engine=self.name,
            ))
        return hits


class StackExchangeSearchEngine:
    """Stack Exchange API (official, documented, no key for low volume)."""

    name = "stackexchange"
    family = "api"

    def __init__(self, site: str = "stackoverflow") -> None:
        self.site = re.sub(r"[^a-z.-]", "", str(site or "stackoverflow").lower())[:40]
        self.timeout = DEFAULT_SEARCH_TIMEOUT_SECONDS

    async def search(self, query: str, *, client: httpx.AsyncClient | None = None) -> list[RawHit]:
        assert client is not None, "API engines require an httpx client"
        text = str(query or "").strip()
        if not text:
            return []
        data = await _get_json(
            client,
            "https://api.stackexchange.com/2.3/search/advanced",
            params={
                "order": "desc",
                "sort": "relevance",
                "q": text[:300],
                "site": self.site,
                "pagesize": MAX_RESULTS_PER_ENGINE,
            },
            timeout=self.timeout,
        )
        import html as _html

        hits: list[RawHit] = []
        for entry in data.get("items", [])[:MAX_RESULTS_PER_ENGINE]:
            if not isinstance(entry, dict):
                continue
            title = _strip_tags(_html.unescape(str(entry.get("title", ""))), 200)
            link = str(entry.get("link", ""))[:2000]
            if not title or not link:
                continue
            score = entry.get("score", 0)
            hits.append(RawHit(
                title=title,
                url=link,
                snippet=_strip_tags(_html.unescape(str(entry.get("body_markdown", "") or "")), 400),
                engine=self.name,
                published_at=str(entry.get("creation_date", "")),
                relevance=min(1.0, max(0.0, float(score)) / 100.0) if isinstance(score, (int, float)) else 0.0,
            ))
        return hits


class HnAlgoliaSearchEngine:
    """Hacker News search via the official Algolia API."""

    name = "hn"
    family = "api"

    def __init__(self) -> None:
        self.timeout = DEFAULT_SEARCH_TIMEOUT_SECONDS

    async def search(self, query: str, *, client: httpx.AsyncClient | None = None) -> list[RawHit]:
        assert client is not None, "API engines require an httpx client"
        text = str(query or "").strip()
        if not text:
            return []
        data = await _get_json(
            client,
            "https://hn.algolia.com/api/v1/search",
            params={"query": text[:300], "hitsPerPage": MAX_RESULTS_PER_ENGINE},
            timeout=self.timeout,
        )
        hits: list[RawHit] = []
        for entry in data.get("hits", [])[:MAX_RESULTS_PER_ENGINE]:
            if not isinstance(entry, dict):
                continue
            title = _strip_tags(str(entry.get("title") or entry.get("story_title") or ""), 200)
            if not title:
                continue
            url = str(entry.get("url") or "")[:2000]
            if not url:
                object_id = re.sub(r"[^A-Za-z0-9]", "", str(entry.get("objectID", "")))[:20]
                if not object_id:
                    continue
                url = f"https://news.ycombinator.com/item?id={object_id}"
            points = entry.get("points", 0)
            hits.append(RawHit(
                title=title,
                url=url,
                snippet=_strip_tags(str(entry.get("story_text") or entry.get("comment_text") or ""), 400),
                engine=self.name,
                published_at=str(entry.get("created_at", ""))[:80],
                relevance=min(1.0, max(0.0, float(points)) / 200.0) if isinstance(points, (int, float)) else 0.0,
            ))
        return hits


class ArxivSearchEngine:
    """arXiv Atom API. Best-effort: slow or unreachable on some networks."""

    name = "arxiv"
    family = "api"

    def __init__(self) -> None:
        self.timeout = BEST_EFFORT_TIMEOUT_SECONDS

    async def search(self, query: str, *, client: httpx.AsyncClient | None = None) -> list[RawHit]:
        assert client is not None, "API engines require an httpx client"
        text = re.sub(r"[\"']", " ", str(query or "")).strip()
        if not text:
            return []
        try:
            response = await client.get(
                "https://export.arxiv.org/api/query",
                params={"search_query": f"all:{text[:200]}", "max_results": MAX_RESULTS_PER_ENGINE},
                timeout=self.timeout,
            )
            response.raise_for_status()
            body = response.content
        except SearchEngineError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise _httpx_error(exc) from exc
        if b"<!DOCTYPE" in body[:512].upper() or b"<!ENTITY" in body[:512].upper():
            raise SearchEngineError("DTD in feed response")
        try:
            root = ET.fromstring(body)
        except ET.ParseError as exc:
            raise SearchEngineError(f"arxiv XML parse failed: {exc}") from exc
        hits: list[RawHit] = []
        for node in root.findall(".//{*}entry")[:MAX_RESULTS_PER_ENGINE]:
            title = _strip_tags("".join((node.findtext("{*}title") or "").split()), 200)
            link = ""
            for link_node in node.findall("{*}link"):
                href = link_node.get("href", "")
                if href:
                    link = str(href)[:2000]
                    break
            if not title or not link:
                continue
            published = (node.findtext("{*}published") or "")[:80]
            summary = _strip_tags(node.findtext("{*}summary") or "", 400)
            hits.append(RawHit(title=title, url=link, snippet=summary, engine=self.name, published_at=published))
        return hits


# ── SERP family (ddgs library; its outbound identity is library-managed) ─


def _default_ddgs_text(query: str, *, region: str, backend: str, max_results: int) -> list[dict[str, Any]]:
    from ddgs import DDGS  # lazy: the dependency is optional at runtime

    return DDGS().text(query, region=region, backend=backend, max_results=max_results)


def _classify_ddgs_error(exc: Exception, *, label: str) -> SearchEngineError:
    """Map a raw ddgs/backend failure onto the three-state contract."""
    name = exc.__class__.__name__
    if name == "RatelimitException" or "ratelimit" in str(exc).lower():
        return SearchEngineError(f"{label}: rate limited", blocked=True, transient=True)
    if name == "TimeoutException" or isinstance(exc, (asyncio.TimeoutError, TimeoutError)):
        return SearchEngineError(f"{label}: timeout")
    return SearchEngineError(f"{label}: {name}: {str(exc)[:160]}")


class DdgsSerpEngine:
    """SERP search via ddgs (MIT) with an ordered backend fallback chain.

    ddgs proxies several independent search backends (bing, duckduckgo, mojeek,
    ...), and any single one can be blocked at any time — DuckDuckGo began
    serving CAPTCHA walls and ddgs issue #480 reports 403s (see
    ``待实施计划/联网搜索新灵感``). A single backend is therefore fragile. This
    engine accepts either one backend (historical behaviour) or an ordered
    chain: a backend that raises (403/timeout/etc.) or returns empty is isolated
    and the next backend is tried. The engine only fails when the whole chain is
    exhausted, and one backend's exception can never discard a later backend's
    results (guards against ddgs #427). All failures still map to the
    blocked/transient/error three-state contract so a block never surfaces as
    "no results".
    """

    family = "serp"

    _BACKEND_RE = re.compile(r"[a-z0-9_-]{1,24}")

    def __init__(
        self,
        backend: "str | list[str]",
        *,
        region: str = "cn-zh",
        text_fn: Callable[..., list[dict[str, Any]]] | None = None,
    ) -> None:
        raw = [backend] if isinstance(backend, str) else list(backend)
        cleaned: list[str] = []
        for item in raw:
            name = str(item or "").strip().lower()
            if not self._BACKEND_RE.fullmatch(name):
                raise ValueError("invalid ddgs backend name")
            if name not in cleaned:
                cleaned.append(name)
        if not cleaned:
            raise ValueError("at least one ddgs backend is required")
        self.backends = cleaned
        # A single backend keeps its historical, per-backend identity so quality
        # weighting and existing wiring stay stable; a chain reports one stable
        # identity used for circuit-breaker and health keying.
        self.name = f"ddgs-{cleaned[0]}" if len(cleaned) == 1 else "ddgs-serp"
        self.region = re.sub(r"[^a-z-]", "", str(region or "cn-zh").lower())[:8] or "cn-zh"
        self._text_fn = text_fn or _default_ddgs_text

    async def search(self, query: str, *, client: httpx.AsyncClient | None = None) -> list[RawHit]:
        text = re.sub(r"\s+", " ", str(query or "")).strip()[:300]
        if not text:
            return []
        errors: list[SearchEngineError] = []
        saw_empty = False
        for backend in self.backends:
            try:
                rows = await asyncio.to_thread(
                    self._text_fn, text, region=self.region, backend=backend,
                    max_results=MAX_RESULTS_PER_ENGINE,
                )
            except SearchEngineError as exc:
                # A pre-classifying text_fn (or a nested engine) already mapped it.
                errors.append(exc)
                continue
            except Exception as exc:  # noqa: BLE001 - isolate this backend, try the next
                errors.append(_classify_ddgs_error(exc, label=f"{self.name}:{backend}"))
                continue
            hits = self._rows_to_hits(rows)
            if hits:
                return hits
            # A successful query with zero hits: remember it, but keep trying the
            # rest of the chain in case this backend soft-blocked us with an empty
            # page. If every backend is genuinely empty we return empty below.
            saw_empty = True
        if saw_empty:
            return []
        # Whole chain failed with no successful answer. Preserve the strongest
        # signal so the breaker cools down correctly: a transient ratelimit on
        # any backend must not become a chronic trip for the whole chain.
        blocked = any(exc.blocked for exc in errors)
        transient = any(exc.transient for exc in errors)
        detail = "; ".join(str(exc) for exc in errors)[:200]
        raise SearchEngineError(
            f"{self.name}: all backends failed: {detail}", blocked=blocked, transient=transient
        )

    def _rows_to_hits(self, rows: Any) -> list[RawHit]:
        hits: list[RawHit] = []
        if not isinstance(rows, list):
            return hits
        for row in rows[:MAX_RESULTS_PER_ENGINE]:
            if not isinstance(row, dict):
                continue
            title = str(row.get("title", "")).strip()[:300]
            url = str(row.get("href", "")).strip()[:2000]
            if not title or not url.startswith(("http://", "https://")):
                continue
            hits.append(RawHit(
                title=title,
                url=url,
                snippet=str(row.get("body", "")).strip()[:1000],
                engine=self.name,
                published_at=str(row.get("date", "") or "")[:80],
            ))
        return hits

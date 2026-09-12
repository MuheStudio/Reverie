"""Search orchestration: circuit breaker, parallel dispatch, RRF fusion.

Clean-room implementation of concepts documented in
``待实施计划/联网搜索新灵感/Reverie借鉴计划.md`` (constants are facts; the
code is original). Key behaviours:

* Three-state engine outcomes — ``ok`` / ``empty`` / failure split into
  blocked vs transient vs error. A block is never reported as "no results".
* Circuit breaker per engine: three chronic failures trip a 60s cooldown that
  doubles up to a 180s ceiling; a transient (429-style) failure cools down in
  seconds and never counts toward the chronic ladder. Success resets.
* Parallel dispatch with a slow-engine deadline (1.2s) and a soft overall
  deadline (3.5s): late engines are abandoned, not awaited.
* Reciprocal-rank fusion (k=60) weighted by per-engine quality, then URL
  normalization dedup (tracking params stripped, params sorted).
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx

from .search_engines import RawHit, SearchEngineError

logger = logging.getLogger("reverie.web.orchestrator")

#: Tracking/noise parameters stripped before dedup and storage.
_NOISE_PARAMS = {"fbclid", "gclid", "ref_src", "spm", "cmpid", "share_token"}


def parse_published_at(raw: str) -> "datetime | None":
    """Best-effort parse of a heterogeneous published-at string to aware UTC.

    Engines report dates in incompatible shapes: a Unix epoch (StackExchange),
    an ISO/Atom timestamp (HN, arXiv), or a free-form ``YYYY-MM-DD`` (ddgs);
    Wikipedia reports none. Recency ranking must degrade gracefully, so an
    unparseable or empty value returns ``None`` (no boost) and this function
    never raises.
    """
    text = str(raw or "").strip()
    if not text:
        return None
    try:
        if re.fullmatch(r"\d{10}", text):
            return datetime.fromtimestamp(int(text), tz=timezone.utc)
        if re.fullmatch(r"\d{13}", text):
            return datetime.fromtimestamp(int(text) / 1000.0, tz=timezone.utc)
        try:
            return datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            pass
        match = re.search(r"(\d{4})-(\d{2})-(\d{2})", text)
        if match:
            return datetime(
                int(match.group(1)), int(match.group(2)), int(match.group(3)),
                tzinfo=timezone.utc,
            )
    except Exception:  # noqa: BLE001 - a malformed date must never break fusion
        return None
    return None


# ── 补砖②: recency demotion + multi-engine consensus ──────────────────────
# Clean-room from wigolo's recency-boost.ts:39 (stale demotion, 14-day grace)
# and consensus-boost.ts:14 (distinct-engine agreement) IDEAS only; the code is
# original. Both are applied as *multiplicative* factors because Reverie fuses
# un-normalized RRF sums (wigolo added consensus in a normalized [0,1] space; an
# additive bonus here would swamp the tiny 1/(k+rank) scores, so a bounded
# multiplier is the scale-correct expression of the same idea). No cross-encoder
# / model download — the boxed-runtime red line forbids that.
RECENCY_GRACE_DAYS = 14
RECENCY_DECAY_DAYS = 30.0
RECENCY_FLOOR = 0.25
CONSENSUS_STEP = 0.1
CONSENSUS_MAX_BONUS = 0.3


def recency_multiplier(
    published: "datetime | None",
    now_utc: datetime,
    *,
    grace_days: int = RECENCY_GRACE_DAYS,
    decay_days: float = RECENCY_DECAY_DAYS,
    floor: float = RECENCY_FLOOR,
) -> float:
    """Demote stale dated pages; never boost. Returns a factor in [floor, 1.0].

    A hit with no parseable date returns 1.0 (undated results are neither
    rewarded nor punished). Anything within the grace window is fresh (1.0);
    beyond it the factor decays exponentially toward ``floor``. Future-dated or
    clock-skewed values stay at 1.0.
    """
    if published is None:
        return 1.0
    try:
        if published.tzinfo is None:
            published = published.replace(tzinfo=timezone.utc)
        age_days = (now_utc - published).total_seconds() / 86400.0
    except Exception:  # noqa: BLE001 - defensive: bad date never breaks ranking
        return 1.0
    if age_days <= grace_days:
        return 1.0
    import math

    decayed = math.exp(-(age_days - grace_days) / max(1.0, decay_days))
    return max(floor, min(1.0, decayed))


def consensus_multiplier(
    engine_count: int,
    *,
    step: float = CONSENSUS_STEP,
    max_bonus: float = CONSENSUS_MAX_BONUS,
) -> float:
    """Reward URLs returned by multiple distinct engines (curation-free trust).

    One engine → 1.0 (no bonus); each extra distinct engine adds ``step`` up to
    a capped ``max_bonus`` so a single popular source can't dominate.
    """
    if engine_count <= 1:
        return 1.0
    return 1.0 + min(step * (engine_count - 1), max_bonus)


def _is_noise_param(key: str) -> bool:
    lowered = key.lower()
    return lowered.startswith("utm_") or lowered in _NOISE_PARAMS


def normalize_url(url: str) -> str:
    """Canonical form used for cross-engine dedup (never used for fetching)."""
    try:
        parts = urlsplit(str(url or "").strip())
    except ValueError:
        return ""
    if parts.scheme.lower() not in {"http", "https"} or not parts.hostname:
        return ""
    scheme = parts.scheme.lower()
    host = parts.hostname.lower()
    try:
        port = parts.port
    except ValueError:
        port = None
    default_port = {"http": 80, "https": 443}.get(scheme)
    netloc = host if port in (None, default_port) else f"{host}:{port}"
    path = parts.path or "/"
    if len(path) > 1 and path.endswith("/"):
        path = path.rstrip("/")
    pairs = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if not _is_noise_param(k)]
    seen: set[tuple[str, str]] = set()
    unique_pairs: list[tuple[str, str]] = []
    for key, value in sorted(pairs):
        if (key, value) not in seen:
            seen.add((key, value))
            unique_pairs.append((key, value))
    query = urlencode(unique_pairs)
    return urlunsplit((scheme, netloc, path, query, ""))


class CircuitBreaker:
    """Per-engine three-state breaker with transient/hard failure separation."""

    CHRONIC_THRESHOLD = 3
    COOLDOWN_SECONDS = 60.0
    MAX_COOLDOWN_SECONDS = 180.0
    TRANSIENT_COOLDOWN_SECONDS = 5.0
    TRANSIENT_MAX_COOLDOWN_SECONDS = 30.0

    def __init__(self) -> None:
        self._failures: dict[str, int] = {}
        self._open_until: dict[str, float] = {}
        self._next_cooldown: dict[str, float] = {}
        self._known: set[str] = set()

    def allow(self, engine: str, *, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        return self._open_until.get(engine, 0.0) <= now

    def record_success(self, engine: str) -> None:
        self._known.add(engine)
        self._failures.pop(engine, None)
        self._open_until.pop(engine, None)
        self._next_cooldown.pop(engine, None)

    def record_failure(self, engine: str, *, transient: bool = False, now: float | None = None) -> None:
        now = time.monotonic() if now is None else now
        self._known.add(engine)
        if transient:
            streak = self._next_cooldown.get(engine, 0.0)
            delay = min(
                self.TRANSIENT_COOLDOWN_SECONDS * (2 ** min(streak, 4)),
                self.TRANSIENT_MAX_COOLDOWN_SECONDS,
            )
            self._next_cooldown[engine] = streak + 1
            self._open_until[engine] = max(self._open_until.get(engine, 0.0), now + delay)
            return
        failures = self._failures.get(engine, 0) + 1
        self._failures[engine] = failures
        if failures >= self.CHRONIC_THRESHOLD:
            already_open = self._open_until.get(engine, 0.0) > now
            if not already_open:
                # One trip per cooldown window: a failure while already open
                # neither extends the outage nor doubles the ladder again.
                previous = self._next_cooldown.get(engine)
                cooldown = (
                    self.COOLDOWN_SECONDS
                    if not previous
                    else min(previous * 2.0, self.MAX_COOLDOWN_SECONDS)
                )
                self._next_cooldown[engine] = cooldown
                self._open_until[engine] = now + cooldown

    def snapshot(self) -> dict[str, dict[str, float | int]]:
        now = time.monotonic()
        return {
            engine: {
                "failures": self._failures.get(engine, 0),
                "open_for_seconds": round(max(0.0, self._open_until.get(engine, 0.0) - now), 1),
            }
            for engine in sorted(self._known)
        }


@dataclass
class OrchestrationResult:
    query: str = ""
    hits: list[RawHit] = field(default_factory=list)
    states: dict[str, str] = field(default_factory=dict)  # engine -> ok|empty|blocked|transient|error|skipped|timeout
    breaker: dict[str, dict[str, float | int]] = field(default_factory=dict)


class SearchOrchestrator:
    """Dispatch one query across engines, fuse and dedup the results."""

    SOFT_DEADLINE_SECONDS = 3.5
    SLOW_ENGINE_DEADLINE_SECONDS = 1.2
    RRF_K = 60
    DEFAULT_MAX_HITS = 12

    def __init__(
        self,
        engines: list,
        *,
        breaker: CircuitBreaker | None = None,
        quality: dict[str, float] | None = None,
    ) -> None:
        self.engines = list(engines)
        self.breaker = breaker or CircuitBreaker()
        self.quality = quality or {}

    def _quality_of(self, engine_name: str) -> float:
        value = self.quality.get(engine_name, 0.7)
        return min(1.0, max(0.1, float(value)))

    async def search(
        self,
        query: str,
        *,
        client: httpx.AsyncClient | None = None,
        now: float | None = None,
        now_utc: "datetime | None" = None,
        slow_deadline: float | None = None,
        soft_deadline: float | None = None,
        max_hits: int | None = None,
    ) -> OrchestrationResult:
        result = OrchestrationResult(query=query)
        slow_deadline = self.SLOW_ENGINE_DEADLINE_SECONDS if slow_deadline is None else slow_deadline
        soft_deadline = self.SOFT_DEADLINE_SECONDS if soft_deadline is None else soft_deadline
        max_hits = self.DEFAULT_MAX_HITS if max_hits is None else max_hits

        runnable = [engine for engine in self.engines if self.breaker.allow(engine.name, now=now)]
        for engine in self.engines:
            if engine not in runnable:
                result.states[engine.name] = "skipped"

        own_client = client is None
        if own_client:
            client = httpx.AsyncClient(
                timeout=httpx.Timeout(10.0, connect=5.0),
                follow_redirects=False,
                headers={"User-Agent": "Reverie-local/1.0 (local companion app)"},
            )
        try:
            tasks = {asyncio.ensure_future(engine.search(query, client=client)): engine for engine in runnable}
            if tasks:
                await self._collect(tasks, result, slow_deadline, soft_deadline)
        finally:
            if own_client:
                await client.aclose()

        if now_utc is None:
            now_utc = datetime.now(timezone.utc)
        result.hits = self._fuse(result, max_hits, now_utc=now_utc)
        result.breaker = self.breaker.snapshot()
        return result

    async def _collect(
        self,
        tasks: dict[asyncio.Future, Any],
        result: OrchestrationResult,
        slow_deadline: float,
        soft_deadline: float,
    ) -> None:
        remaining = dict(tasks)
        for window in (slow_deadline, max(0.1, soft_deadline - slow_deadline)):
            if not remaining:
                break
            done, _pending = await asyncio.wait(
                set(remaining), timeout=window, return_when=asyncio.ALL_COMPLETED
            )
            for task in done:
                engine = remaining.pop(task)
                try:
                    hits = task.result()
                except SearchEngineError as exc:
                    result.states[engine.name] = "transient" if exc.transient else ("blocked" if exc.blocked else "error")
                    self.breaker.record_failure(engine.name, transient=exc.transient)
                    logger.debug("engine %s failed: %s", engine.name, exc)
                except Exception as exc:  # noqa: BLE001 - engine isolation
                    result.states[engine.name] = "error"
                    self.breaker.record_failure(engine.name)
                    logger.debug("engine %s crashed: %s", engine.name, exc)
                else:
                    result.states[engine.name] = "ok" if hits else "empty"
                    self.breaker.record_success(engine.name)
                    result.hits.extend(hits)
        for task, engine in remaining.items():
            task.cancel()
            result.states[engine.name] = "timeout"

    def _fuse(self, result: OrchestrationResult, max_hits: int, *, now_utc: datetime) -> list[RawHit]:
        rrf_scores: dict[str, float] = {}
        first_hit: dict[str, RawHit] = {}
        per_engine_rank: dict[str, int] = {}
        engines_by_key: dict[str, set[str]] = {}
        for hit in result.hits:
            key = normalize_url(hit.url)
            if not key:
                continue
            rank = per_engine_rank.get(hit.engine, 0) + 1
            per_engine_rank[hit.engine] = rank
            rrf_scores[key] = rrf_scores.get(key, 0.0) + self._quality_of(hit.engine) / (self.RRF_K + rank)
            engines_by_key.setdefault(key, set()).add(hit.engine)
            first_hit.setdefault(key, hit)
        # Refine the base RRF order with two bounded, multiplicative signals:
        # stale dated pages are demoted (undated pages unchanged) and URLs that
        # multiple distinct engines returned are boosted as a curation-free
        # trust proxy. Applied after accumulation so each URL is adjusted once.
        adjusted: dict[str, float] = {}
        for key, base in rrf_scores.items():
            hit = first_hit[key]
            recency = recency_multiplier(parse_published_at(hit.published_at), now_utc)
            consensus = consensus_multiplier(len(engines_by_key.get(key, ())))
            adjusted[key] = base * recency * consensus
        ranked = sorted(adjusted.items(), key=lambda item: item[1], reverse=True)[:max_hits]
        fused: list[RawHit] = []
        for key, score in ranked:
            hit = first_hit[key]
            fused.append(RawHit(
                title=hit.title,
                url=hit.url,
                snippet=hit.snippet,
                engine=hit.engine,
                published_at=hit.published_at,
                relevance=score,
            ))
        return fused

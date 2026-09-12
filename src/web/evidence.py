"""Evidence anchoring: verbatim excerpts, stable citation ids, orphan stripping.

Clean-room implementation of concepts documented in
``待实施计划/联网搜索新灵感/Reverie借鉴计划.md``.

* ``split_passages`` walks a clean text block-by-block recording the exact
  ``{char_start, char_end}`` span of every kept passage, so an excerpt is
  always a verbatim slice of the text we actually hold.
* ``stable_citation_id`` derives a short id from ``url#char_start`` so the
  same excerpt always carries the same id across sessions.
* ``strip_orphan_citations`` removes ``[N]`` markers from a generated reply
  when ``N`` does not point at evidence we actually injected — fabricated
  citations never reach the user.
"""

from __future__ import annotations

import hashlib
import logging
import re
import threading
from dataclasses import dataclass
from typing import Any

import httpx

logger = logging.getLogger("reverie.web.evidence")

# trafilatura 2.x is not thread-safe (lxml C-layer race, adbar/trafilatura#925):
# concurrent extract() calls can SIGSEGV the whole process. Serialize every
# extraction through one lock so the web surfing loop can never crash chat.
_TRAFILATURA_LOCK = threading.Lock()

CITATION_MARKER = re.compile(r"\[(\d{1,2})\]")
MAX_EXCERPT_CHARS = 500
DEFAULT_MAX_EVIDENCE_ITEMS = 4
PAGE_MAX_BYTES = 500_000


@dataclass(frozen=True)
class Passage:
    text: str
    char_start: int
    char_end: int


def stable_citation_id(url: str, char_start: int) -> str:
    return hashlib.sha1(f"{url}#{int(char_start)}".encode("utf-8", errors="ignore")).hexdigest()[:12]


def _extract_body_with_lock(html: str) -> str | None:
    """Run trafilatura.extract under the global serialization lock.

    trafilatura 2.x is not thread-safe at the lxml C layer, so concurrent
    calls from the asyncio web-surfing loop can SIGSEGV the whole process.
    All extraction funnels through this one helper; returns None on any
    failure so the caller can fall back to the crude tag strip.
    """
    try:
        import trafilatura  # lazy: optional dependency
    except ImportError:
        return None
    with _TRAFILATURA_LOCK:
        extracted = trafilatura.extract(
            html,
            output_format="txt",
            include_comments=False,
            include_tables=False,
        )
    if not extracted or not str(extracted).strip():
        return None
    return str(extracted).strip()


def split_passages(text: str, *, min_chars: int = 30) -> list[Passage]:
    """Split on blank lines, trim, and keep verbatim char-anchored passages."""
    if not text:
        return []
    out: list[Passage] = []
    block_start = 0
    for match in re.finditer(r"\n\s*\n+", text):
        _consider(text, block_start, match.start(), min_chars, out)
        block_start = match.end()
    _consider(text, block_start, len(text), min_chars, out)
    return out


def _consider(text: str, raw_start: int, raw_end: int, min_chars: int, out: list[Passage]) -> None:
    raw = text[raw_start:raw_end]
    stripped = raw.strip()
    if len(stripped) < min_chars:
        return
    leading = len(raw) - len(raw.lstrip())
    trailing = len(raw) - len(raw.rstrip())
    char_start = raw_start + leading
    char_end = raw_end - trailing
    kept = text[char_start:char_end]
    excerpt = kept[:MAX_EXCERPT_CHARS]
    out.append(Passage(text=excerpt, char_start=char_start, char_end=char_start + len(excerpt)))


def build_evidence(
    page_text: str,
    url: str,
    *,
    query_terms: list[str] | None = None,
    max_items: int = DEFAULT_MAX_EVIDENCE_ITEMS,
) -> list[dict[str, Any]]:
    """Pick the most query-relevant verbatim passages and anchor them."""
    passages = split_passages(page_text)
    if not passages:
        return []
    terms = [re.sub(r"\s+", " ", str(term or "")).strip().lower() for term in (query_terms or [])]
    terms = [term for term in terms if term]

    def score(passage: Passage) -> float:
        lowered = passage.text.lower()
        return float(sum(1 for term in terms if term in lowered)) if terms else 0.0

    ranked = sorted(passages, key=lambda p: (score(p), -p.char_start), reverse=True)
    evidence: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for passage in ranked:
        citation = stable_citation_id(url, passage.char_start)
        if citation in seen_ids:
            continue
        seen_ids.add(citation)
        evidence.append({
            "excerpt": passage.text,
            "char_start": passage.char_start,
            "char_end": passage.char_end,
            "citation_id": citation,
            "score": score(passage),
        })
        if len(evidence) >= max_items:
            break
    return evidence


def strip_orphan_citations(text: str, max_index: int) -> str:
    """Drop ``[N]`` markers that do not point at real injected evidence."""
    if not text or max_index < 1:
        return CITATION_MARKER.sub("", str(text or ""))
    kept: list[str] = []
    cursor = 0
    for match in CITATION_MARKER.finditer(str(text)):
        index = int(match.group(1))
        kept.append(str(text)[cursor:match.start()])
        if 1 <= index <= max_index:
            kept.append(match.group(0))
        cursor = match.end()
    kept.append(str(text)[cursor:])
    return "".join(kept)


async def fetch_page_text(
    url: str,
    *,
    client: httpx.AsyncClient,
    timeout_s: float = 12.0,
    max_bytes: int = PAGE_MAX_BYTES,
) -> str | None:
    """Fetch one https page and extract its main text.

    Returns ``None`` on any failure (fail-open: a page that cannot be read is
    dropped, never escalated to a browser). SSRF gate: reuse the surfing
    system's public-https-only check before any connection.
    """
    from . import _is_public_https_url

    if not await _is_public_https_url(str(url or "")):
        logger.debug("evidence: non-public URL rejected: %s", url)
        return None
    try:
        async with client.stream("GET", str(url), timeout=timeout_s) as response:
            if response.status_code != 200:
                return None
            content_type = response.headers.get("content-type", "").lower()
            if content_type and not any(token in content_type for token in ("html", "text/plain", "xhtml")):
                return None
            body = bytearray()
            async for chunk in response.aiter_bytes():
                body.extend(chunk)
                if len(body) > max_bytes:
                    return None
    except Exception as exc:  # noqa: BLE001 - fail-open by design
        logger.debug("evidence: fetch failed for %s: %s", url, exc)
        return None

    extracted = _extract_body_with_lock(bytes(body).decode("utf-8", errors="replace"))
    if extracted:
        return extracted[:20_000]

    # Fallback: crude tag strip (keeps the feature alive without trafilatura).
    text = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", bytes(body).decode("utf-8", errors="replace"))
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    text = re.sub(r"[ \t\f\v]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n\n", text)
    return text.strip()[:20_000] or None

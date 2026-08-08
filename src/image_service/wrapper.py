"""foxgirls.club 随机图片服务 —— Reverie 本地封装。

原始项目: foxgirls.club (MIT) — https://github.com/foxgirls-club/foxgirls.club
适配修改: Muhe Studio 2026

职责：
  - 读取 foxgirls.club 的 db.json 索引（兼容 ``{sfw: {hash: item}}`` 字典结构与
    ``{sfw: [item]}`` 列表结构两种形态）
  - 按 SFW / NSFW / 随机 模式挑选图片条目（hide_loli 默认开启）
  - 由本服务（而非渲染器）抓取源图，并转成 data URL 返回，避免渲染器直连外部源站
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import random
from pathlib import Path
from typing import Any

import httpx

logger = logging.getLogger("reverie.image_service")

ALLOWED_CONTENT_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}
MAX_IMAGE_BYTES = 10 * 1024 * 1024


class FoxgirlImageService:
    """foxgirls.club 随机图片服务封装。"""

    def __init__(
        self,
        db_path: Path | None = None,
        *,
        hide_loli: bool = True,
        only_loli: bool = False,
        timeout: float = 20.0,
    ) -> None:
        self._path = Path(db_path or (Path(__file__).resolve().parent / "db.json"))
        self._hide_loli = hide_loli
        self._only_loli = only_loli
        self._timeout = timeout
        self._db: dict[str, Any] = {}
        self._load()

    def _load(self) -> None:
        if not self._path.exists():
            logger.warning("foxgirls db.json 不存在: %s", self._path)
            return
        try:
            with self._path.open("r", encoding="utf-8") as handle:
                data = json.load(handle)
            self._db = data if isinstance(data, dict) else {}
        except Exception:
            logger.exception("foxgirls db.json 解析失败")

    @staticmethod
    def _entries_of(bucket: Any) -> list[tuple[str, dict[str, Any]]]:
        """把字典结构 ``{hash: entry}`` 或列表结构 ``[entry]`` 归一化为 [(key, entry)]。"""
        if isinstance(bucket, dict):
            return [
                (str(key), value)
                for key, value in bucket.items()
                if isinstance(value, dict)
            ]
        if isinstance(bucket, list):
            return [
                (str(item.get("hash") or item.get("id") or str(index)), item)
                for index, item in enumerate(bucket)
                if isinstance(item, dict)
            ]
        return []

    def _passes_filters(self, entry: dict[str, Any]) -> bool:
        is_loli = bool(entry.get("is_loli") or entry.get("has_loli"))
        if self._hide_loli and is_loli:
            return False
        if self._only_loli and not is_loli:
            return False
        return True

    def _pick(self, mode: str) -> dict[str, Any] | None:
        if not self._db:
            return None
        if mode in ("sfw", "nsfw") and isinstance(self._db.get(mode), (dict, list)):
            buckets = [self._db[mode]]
        else:
            buckets = [
                self._db[key]
                for key in ("sfw", "nsfw")
                if isinstance(self._db.get(key), (dict, list))
            ]
        candidates = [
            entry
            for bucket in buckets
            for _key, entry in self._entries_of(bucket)
            if self._passes_filters(entry)
        ]
        if not candidates:
            return None
        return random.choice(candidates)

    @staticmethod
    def _source_url(entry: dict[str, Any]) -> str:
        return str(entry.get("url") or entry.get("link") or "").strip()

    async def get_random(self, mode: str = "sfw") -> dict[str, Any]:
        """返回 ``{"url": "data:image/...;base64,...", "mode": mode}``。"""
        entry = self._pick(mode)
        if entry is None:
            return {"url": None, "error": "没有可用的图片"}
        source = self._source_url(entry)
        if not source:
            return {"url": None, "error": "图片条目缺少来源 URL"}
        try:
            url = await asyncio.to_thread(self._fetch_as_data_url, source)
            return {"url": url, "mode": mode}
        except Exception as exc:
            logger.exception("foxgirls 图片抓取失败")
            return {"url": None, "error": str(exc)}

    def _fetch_as_data_url(self, source: str) -> str:
        # Redirects are disabled: entries come from a local db.json which may
        # be user-edited, and a redirect chain could smuggle a request to an
        # internal address. Source URLs should resolve directly.
        with httpx.Client(timeout=self._timeout, follow_redirects=False) as client:
            response = client.get(
                source,
                headers={
                    "User-Agent": (
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
                    ),
                    "Referer": "https://gelbooru.com/",
                },
            )
            response.raise_for_status()
            content_type = response.headers.get("content-type", "").split(";")[0].strip()
            if content_type not in ALLOWED_CONTENT_TYPES:
                raise RuntimeError(f"意外的图片内容类型: {content_type}")
            body = response.content
            if len(body) > MAX_IMAGE_BYTES:
                raise ValueError(f"图片超过安全大小上限: {len(body)} bytes")
            encoded = base64.b64encode(body).decode("ascii")
            return f"data:{content_type};base64,{encoded}"


__all__ = ["ALLOWED_CONTENT_TYPES", "FoxgirlImageService"]

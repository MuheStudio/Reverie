"""Privacy-bounded Amap POI adapter for explicit foreground requests."""

from __future__ import annotations

import asyncio
import json
import math
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import httpx

from ..local_mode import LocalModeBlocked, get_local_mode_gate


AMAP_HOST = "restapi.amap.com"
CONVERT_URL = f"https://{AMAP_HOST}/v3/assistant/coordinate/convert"
AROUND_URL = f"https://{AMAP_HOST}/v5/place/around"
MAX_RESPONSE_BYTES = 128 * 1024
MAX_ITEMS = 8

# Closed product vocabulary. Values are Amap's documented POI type prefixes.
CATEGORY_TYPES = {
    "restaurant": "050000",
    "cafe": "050500",
    "bakery": "050800",
    "dessert": "050900",
    "convenience": "060200",
    "snacks": "050000",
    "supermarket": "060100",
}
CATEGORY_LABELS = {
    "restaurant": "餐厅",
    "cafe": "咖啡店",
    "bakery": "烘焙店",
    "dessert": "甜品店",
    "convenience": "便利店",
    "snacks": "小吃店",
    "supermarket": "超市",
}


class AmapError(Exception):
    """A stable, non-sensitive adapter failure."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class AmapPOIItem:
    name: str
    broad_category: str
    distance_band: str
    district: str
    short_address: str
    provider: str
    observed_at: str

    def to_dict(self) -> dict[str, str]:
        return {
            "name": self.name,
            "broad_category": self.broad_category,
            "distance_band": self.distance_band,
            "district": self.district,
            "short_address": self.short_address,
            "provider": self.provider,
            "observed_at": self.observed_at,
        }


@dataclass(frozen=True)
class AmapPOIResult:
    items: list[AmapPOIItem]
    provider: str = "Amap"


def _clean_text(value: Any, maximum: int) -> str:
    text = str(value or "").strip()
    text = " ".join(text.split())
    return "".join(char for char in text if ord(char) >= 32 and char != "\x7f")[:maximum]


def _distance_band(value: Any) -> str:
    try:
        distance = max(0, float(value))
    except (TypeError, ValueError):
        return "unknown"
    if distance < 250:
        return "within-250m"
    if distance < 500:
        return "250-500m"
    if distance < 1000:
        return "500m-1km"
    if distance < 2000:
        return "1-2km"
    return "over-2km"


class AmapPOIService:
    """Convert WGS84 GPS and query the pinned Amap HTTPS endpoint once per category."""

    def __init__(self, api_key: str, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        key = str(api_key or "")
        if not key or len(key) > 256 or any(ord(char) < 33 or ord(char) > 126 for char in key):
            raise AmapError("key-required")
        self._api_key = key
        self._transport = transport
        self._converted: tuple[float, float, str] | None = None
        self._convert_lock = asyncio.Lock()

    async def _json(self, client: httpx.AsyncClient, url: str, params: dict[str, str]) -> dict[str, Any]:
        try:
            async with asyncio.timeout(4.5):
                async with client.stream("GET", url, params=params) as response:
                    if response.status_code != 200:
                        raise AmapError("unavailable")
                    body = bytearray()
                    async for chunk in response.aiter_bytes():
                        body.extend(chunk)
                        if len(body) > MAX_RESPONSE_BYTES:
                            raise AmapError("unavailable")
        except AmapError:
            raise
        except (TimeoutError, httpx.TimeoutException) as error:
            raise AmapError("timeout") from error
        except (httpx.HTTPError, OSError) as error:
            raise AmapError("unavailable") from error
        try:
            value = json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise AmapError("unavailable") from error
        if not isinstance(value, dict):
            raise AmapError("unavailable")
        if str(value.get("status")) != "1":
            info = str(value.get("infocode") or "")
            if info in {"10001", "10002", "10003", "10004", "10009", "10021", "10044"}:
                raise AmapError("quota")
            raise AmapError("unavailable")
        return value

    async def _convert(
        self,
        client: httpx.AsyncClient,
        latitude: float,
        longitude: float,
    ) -> str:
        coordinate_tag = f"{longitude:.7f},{latitude:.7f}"
        async with self._convert_lock:
            if self._converted and self._converted[:2] == (latitude, longitude):
                return self._converted[2]
            value = await self._json(client, CONVERT_URL, {
                "key": self._api_key,
                "locations": coordinate_tag,
                "coordsys": "gps",
            })
            converted = str(value.get("locations") or "")
            parts = converted.split(",")
            try:
                valid = len(parts) == 2 and all(math.isfinite(float(part)) for part in parts)
            except ValueError:
                valid = False
            if not valid or len(converted) > 64:
                raise AmapError("unavailable")
            self._converted = (latitude, longitude, converted)
            return converted

    async def search_category(
        self,
        category: str,
        latitude: float,
        longitude: float,
        *,
        radius: int,
        limit: int = 3,
    ) -> AmapPOIResult:
        get_local_mode_gate().require_remote("Amap nearby request")
        if category not in CATEGORY_TYPES:
            return AmapPOIResult([])
        timeout = httpx.Timeout(6.0, connect=2.5)
        try:
            async with asyncio.timeout(6.0):
                async with httpx.AsyncClient(
                    transport=self._transport,
                    timeout=timeout,
                    follow_redirects=False,
                    trust_env=False,
                ) as client:
                    location = await self._convert(client, float(latitude), float(longitude))
                    value = await self._json(client, AROUND_URL, {
                        "key": self._api_key,
                        "location": location,
                        "types": CATEGORY_TYPES[category],
                        "radius": str(max(300, min(5000, int(radius)))),
                        "sortrule": "distance",
                        "page_size": str(max(1, min(MAX_ITEMS, int(limit)))),
                        "page_num": "1",
                    })
        except TimeoutError as error:
            raise AmapError("timeout") from error
        pois = value.get("pois")
        if not isinstance(pois, list):
            raise AmapError("unavailable")
        observed_at = datetime.now(UTC).isoformat(timespec="seconds")
        items: list[AmapPOIItem] = []
        for poi in pois[: min(MAX_ITEMS, max(1, int(limit)))]:
            if not isinstance(poi, dict):
                continue
            name = _clean_text(poi.get("name"), 80)
            if not name:
                continue
            items.append(AmapPOIItem(
                name=name,
                broad_category=CATEGORY_LABELS[category],
                distance_band=_distance_band(poi.get("distance")),
                district=_clean_text(poi.get("adname"), 40),
                short_address=_clean_text(poi.get("address"), 80),
                provider="Amap",
                observed_at=observed_at,
            ))
        return AmapPOIResult(items)


def stable_amap_error(error: BaseException) -> str:
    if isinstance(error, LocalModeBlocked):
        return "local-mode"
    if isinstance(error, AmapError):
        return error.code
    return "unavailable"

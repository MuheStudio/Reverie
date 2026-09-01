"""Immersion helpers for location, daily-life scenes, and smart-home dry runs.

This module is deliberately conservative: it never asks for location by itself,
never stores precise coordinates, and never controls a real device unless a
future vendor adapter explicitly replaces the dry-run controller.
"""

from __future__ import annotations

import asyncio
import math
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Callable

if TYPE_CHECKING:
    from ..config.settings import FeatureSettings


ALLOWED_PLACE_TYPES = {
    "restaurant": "饭店",
    "cafe": "咖啡店",
    "bakery": "烘焙店",
    "dessert": "甜品店",
    "convenience": "便利店",
    "snacks": "小吃店",
    "supermarket": "超市",
}

POI_QUERIES = {
    "restaurant": "餐厅",
    "cafe": "咖啡",
    "bakery": "烘焙",
    "dessert": "甜品",
    "convenience": "便利店",
    "snacks": "小吃",
    "supermarket": "超市",
}

SCENE_TEMPLATES = {
    "restaurant": ["问你要不要一起点外卖", "路过饭店时聊晚饭吃什么"],
    "shop": ["想起要买小东西", "看到可爱的东西想收藏截图"],
    "cafe": ["说自己想喝点热的", "发一条像在咖啡店摸鱼的动态"],
    "supermarket": ["讨论做饭要买什么菜", "提醒你别忘了买日用品"],
    "park": ["散步时发来一条短消息", "朋友圈发一点晚风和路灯"],
    "mall": ["吐槽自己差点迷路", "说看到了很可爱的周边"],
}


@dataclass
class NearbyPlace:
    kind: str
    label: str
    confidence: float

    def to_dict(self) -> dict:
        return {
            "kind": self.kind,
            "label": self.label,
            "confidence": round(self.confidence, 2),
        }


class ImmersionManager:
    """Builds privacy-preserving daily-life immersion suggestions."""

    def __init__(
        self,
        feature_settings: "FeatureSettings | None" = None,
        poi_service_factory: Callable[[], Any] | None = None,
        vendor_adapter_factory: Callable[[str], Any] | None = None,
    ) -> None:
        self.feature_settings = feature_settings
        self._poi_service_factory = poi_service_factory
        self._vendor_adapter_factory = vendor_adapter_factory

    def nearby_life_context(
        self,
        *,
        latitude: float,
        longitude: float,
        place_types: list[str] | None = None,
        radius_m: int | None = None,
    ) -> dict:
        """Return nearby place-type suggestions without storing exact location."""
        if not _valid_coordinate(latitude, longitude):
            return {"ok": False, "error": "Invalid coordinates", "places": [], "suggestions": []}

        enabled = bool(getattr(self.feature_settings, "immersion_location_enabled", False))
        if not enabled:
            return {
                "ok": False,
                "error": "Location immersion is disabled",
                "places": [],
                "suggestions": [],
            }

        try:
            radius = int(radius_m or getattr(self.feature_settings, "immersion_location_radius_m", 1200))
        except (TypeError, ValueError):
            radius = int(getattr(self.feature_settings, "immersion_location_radius_m", 1200))
        radius = max(300, min(5000, radius))
        selected = _sanitize_place_types(place_types)
        if not selected:
            selected = ["restaurant", "cafe", "bakery", "supermarket"]

        places = [
            NearbyPlace(kind=kind, label=ALLOWED_PLACE_TYPES[kind], confidence=0.55 + index * 0.05)
            for index, kind in enumerate(selected[:6])
        ]
        suggestions = [
            {
                "kind": place.kind,
                "label": place.label,
                "ideas": SCENE_TEMPLATES.get(place.kind, [])[:2],
            }
            for place in places
        ]
        return {
            "ok": True,
            "provider": "local-privacy-preserving",
            "radius_m": radius,
            "places": [place.to_dict() for place in places],
            "suggestions": suggestions,
            "privacy": "Location is used only for this request and is not returned or stored.",
        }

    async def nearby_life_context_async(
        self,
        *,
        latitude: float,
        longitude: float,
        place_types: list[str] | None = None,
        radius_m: int | None = None,
    ) -> dict:
        """Return real POI-backed suggestions when possible, with local fallback."""
        base = self.nearby_life_context(
            latitude=latitude,
            longitude=longitude,
            place_types=place_types,
            radius_m=radius_m,
        )
        if not base.get("ok"):
            return base

        selected = [place["kind"] for place in base.get("places", []) if isinstance(place, dict)]
        service = _make_poi_service(self._poi_service_factory)
        if not service:
            base["provider"] = "local-privacy-preserving"
            base["poi_status"] = "unavailable"
            return base

        try:
            real_places = await _search_real_poi(
                service=service,
                latitude=float(latitude),
                longitude=float(longitude),
                radius_m=int(base.get("radius_m", 1200)),
                place_types=selected,
            )
        except Exception as error:
            base["provider"] = "local-privacy-preserving"
            code = str(getattr(error, "code", "") or "")
            base["poi_status"] = code if code in {"timeout", "quota", "unavailable", "local-mode"} else "failed"
            return base

        if not real_places:
            base["provider"] = "local-privacy-preserving"
            base["poi_status"] = "empty"
            return base

        base["provider"] = "real-poi-with-local-fallback"
        base["poi_status"] = "ok"
        base["real_places"] = real_places
        base["places"] = _merge_place_confidence(base.get("places", []), real_places)
        base["suggestions"] = _suggestions_from_real_places(real_places, base.get("suggestions", []))
        base["privacy"] = (
            "Location is used only for this request and is not returned or stored."
        )
        return base

    def closeup_prompt_plan(self, kind: str = "meal") -> dict:
        """Return a multimodal close-up generation plan when explicitly enabled."""
        enabled = bool(getattr(self.feature_settings, "immersion_closeups_enabled", False))
        clean_kind = str(kind or "meal").strip().lower()
        if clean_kind not in {"meal", "cooking", "bath", "shopping"}:
            clean_kind = "meal"
        if not enabled:
            return {
                "ok": False,
                "kind": clean_kind,
                "error": "Multimodal close-ups are disabled",
            }
        prompts = {
            "meal": "一张温暖的饭桌近景，角色正在分享今天吃了什么，手机随手拍质感",
            "cooking": "厨房台面近景，简单食材和正在准备的料理，生活感强",
            "bath": "浴室门外的生活提示画面，不暴露隐私，只表现洗澡后的雾气与毛巾",
            "shopping": "商店货架近景，看到可爱小物时的随手记录感",
        }
        return {"ok": True, "kind": clean_kind, "prompt": prompts[clean_kind], "requires_multimodal_api": True}

    def smart_home_command(self, *, provider: str, device: str, action: str) -> dict:
        """Return a safe smart-home command envelope.

        Without a configured vendor adapter this stays a dry run that never
        controls a real device. When the owner later supplies vendor
        credentials (e.g. Xiaomi / Huawei open-platform OAuth), the injected
        ``vendor_adapter_factory`` can replace the dry-run controller; until
        then the envelope is returned unchanged and the note makes it clear
        nothing was controlled.
        """
        enabled = bool(getattr(self.feature_settings, "immersion_smart_home_enabled", False))
        provider_clean = str(provider or "manual").strip().lower()
        device_clean = str(device or "").strip()[:40]
        action_clean = str(action or "").strip()[:80]
        if not enabled:
            return {"ok": False, "dry_run": True, "error": "Smart-home immersion is disabled"}
        if provider_clean not in {"manual", "xiaomi", "huawei"}:
            provider_clean = "manual"
        if not device_clean or not action_clean:
            return {"ok": False, "dry_run": True, "error": "Device and action are required"}
        envelope = {
            "ok": True,
            "dry_run": True,
            "provider": provider_clean,
            "device": device_clean,
            "action": action_clean,
            "note": "Dry-run only. No real smart-home device was controlled.",
        }
        factory = self._vendor_adapter_factory
        if factory is None or provider_clean == "manual":
            return envelope
        try:
            adapter = factory(provider_clean)
        except Exception as exc:
            envelope["note"] = (
                f"Vendor adapter for {provider_clean} is not configured; dry-run only ({exc})."
            )
            return envelope
        if adapter is None:
            envelope["note"] = (
                f"No credentials configured for {provider_clean}; dry-run only."
            )
            return envelope
        try:
            return {
                **envelope,
                "ok": True,
                "dry_run": False,
                "controller": provider_clean,
                "result": adapter.execute(device=device_clean, action=action_clean),
                "note": "Controlled through the configured vendor adapter.",
            }
        except Exception as exc:
            envelope["note"] = f"Vendor control failed; dry-run preserved ({exc})."
            return envelope


def _valid_coordinate(latitude: float, longitude: float) -> bool:
    try:
        lat = float(latitude)
        lon = float(longitude)
    except (TypeError, ValueError):
        return False
    return math.isfinite(lat) and math.isfinite(lon) and -90 <= lat <= 90 and -180 <= lon <= 180


def _sanitize_place_types(place_types: list[str] | None) -> list[str]:
    if not isinstance(place_types, list):
        return []
    selected: list[str] = []
    for item in place_types:
        kind = str(item).strip().lower()
        if kind in ALLOWED_PLACE_TYPES and kind not in selected:
            selected.append(kind)
    return selected


def _make_poi_service(factory: Callable[[], Any] | None) -> Any | None:
    # POI is an explicit adapter port. The kernel must never discover or import
    # a reference project behind the user's back: doing so reintroduces an
    # undeclared network path and makes an optional module a startup dependency.
    # Production currently injects no adapter and therefore remains local.
    return factory() if factory else None


async def _search_real_poi(
    *,
    service: Any,
    latitude: float,
    longitude: float,
    radius_m: int,
    place_types: list[str],
) -> list[dict[str, Any]]:
    queries = [POI_QUERIES[kind] for kind in place_types[:4] if kind in POI_QUERIES]
    if not queries:
        return []

    async def run_one(query: str) -> list[dict[str, Any]]:
        kind = next((key for key, value in POI_QUERIES.items() if value == query), "")
        if hasattr(service, "search_category"):
            result = await service.search_category(
                kind, latitude, longitude, radius=radius_m, limit=3
            )
            return [item.to_dict() for item in list(getattr(result, "items", []) or [])[:3]]
        result = await service.search(query, latitude, longitude, radius=radius_m, limit=3)
        provider = str(getattr(result, "provider", "") or "")
        entries: list[dict[str, Any]] = []
        for item in list(getattr(result, "items", []) or [])[:3]:
            name = str(getattr(item, "name", "") or "").strip()
            if not name:
                continue
            entries.append(
                {
                    "query": query,
                    "name": name[:80],
                    "address": str(getattr(item, "address", "") or "").strip()[:120],
                    "type": str(getattr(item, "type_name", "") or "").strip()[:80],
                    "distance_m": round(float(getattr(item, "distance_m", 0) or 0)),
                    "provider": provider,
                }
            )
        return entries

    tasks = [asyncio.create_task(run_one(query)) for query in queries]
    done, pending = await asyncio.wait(tasks, timeout=5.0)
    for task in pending:
        task.cancel()
    places: list[dict[str, Any]] = []
    for task in done:
        if task.cancelled():
            continue
        if task.exception():
            continue
        places.extend(task.result())
    if not places:
        first_error = next(
            (task.exception() for task in done if not task.cancelled() and task.exception()),
            None,
        )
        if first_error:
            raise first_error
    places.sort(key=lambda item: item.get("distance_m", 0))
    return places[:8]


def _merge_place_confidence(local_places: Any, real_places: list[dict[str, Any]]) -> list[dict[str, Any]]:
    counts: dict[str, int] = {}
    for place in real_places:
        query = str(place.get("query", ""))
        counts[query] = counts.get(query, 0) + 1
    merged: list[dict[str, Any]] = []
    for place in local_places if isinstance(local_places, list) else []:
        if not isinstance(place, dict):
            continue
        kind = str(place.get("kind", ""))
        query = POI_QUERIES.get(kind, "")
        next_place = dict(place)
        if query and counts.get(query):
            next_place["confidence"] = min(0.95, float(next_place.get("confidence", 0.6)) + counts[query] * 0.08)
            next_place["sample_count"] = counts[query]
        merged.append(next_place)
    return merged


def _suggestions_from_real_places(
    real_places: list[dict[str, Any]],
    fallback: Any,
) -> list[dict[str, Any]]:
    suggestions: list[dict[str, Any]] = []
    for place in real_places[:6]:
        name = str(place.get("name", "附近的店"))
        query = str(place.get("query", "附近"))
        distance = int(place.get("distance_m", 0) or 0)
        ideas = [
            f"路过{name}时发一条像随手想到你的消息",
            f"把{query}当作今天生活感动态的背景",
        ]
        if distance > 0:
            ideas.append(f"提到它大概在 {distance} 米以内，不暴露精确定位")
        suggestions.append(
            {
                "kind": query,
                "label": name,
                "ideas": ideas[:2],
                "distance_m": distance,
            }
        )
    if suggestions:
        return suggestions
    return fallback if isinstance(fallback, list) else []

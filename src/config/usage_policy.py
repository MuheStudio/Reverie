"""Deny-by-default consent gate for optional API and network work.

The policy is deliberately checked before budget bookkeeping, provider client
creation, DNS, HTTP, or any other observable side effect.  A lease also guards
the return path: revoking consent while a request is in flight prevents its
result from being persisted or delivered, and ``revoke`` cancels tasks that
used the policy API to register their work.
"""

from __future__ import annotations

import asyncio
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, Literal, TypeVar, TYPE_CHECKING
from urllib.parse import urlsplit

if TYPE_CHECKING:
    from .settings import _Settings


_T = TypeVar("_T")


OptionalAIFeature = Literal[
    "proactive_chat",
    "diary_generation",
    "web_access",
    "image_generation",
    "timeline_generation",
    "memory_enrichment",
    "social_generation",
    "semantic_verification",
    "emotion_analysis",
    "other_background_generation",
]


FEATURE_DESCRIPTIONS: dict[OptionalAIFeature, str] = {
    "semantic_verification": "AI semantic verification makes an additional model call after the main reply to check factual continuity and may incur API charges.",
    "emotion_analysis": "AI emotion analysis makes an additional model call after the main reply; when disabled, Reverie uses local rules instead.",
    "proactive_chat": "主动聊天会在你没有发送消息时调用所选 AI 服务，可能产生 API 费用。",
    "diary_generation": "AI 日记会根据本地事实额外调用 AI 生成和核验内容，可能产生 API 费用。",
    "web_access": "联网搜索或 RSS 刷新会访问互联网；后续摘要或生成还可能产生 API 费用。",
    "image_generation": "图片生成会把你的提示发送给所选图片服务，并可能产生 API 费用。",
    "timeline_generation": "角色动态会在后台额外调用 AI 生成和核验内容，可能产生 API 费用。",
    "memory_enrichment": "AI 记忆摘要或判断会额外调用 AI；关闭后仍使用完全本地的规则与检索。",
    "social_generation": "群聊角色或动态评论的 AI 回复会额外调用 AI，可能产生 API 费用。",
    "other_background_generation": "其他后台 AI 任务会在你未主动发送消息时调用服务，可能产生 API 费用。",
}


PURPOSE_TO_FEATURE: dict[str, OptionalAIFeature] = {
    "proactive_chat": "proactive_chat",
    "diary_generation": "diary_generation",
    "diary_consistency": "diary_generation",
    "web_search": "web_access",
    "web_summary": "web_access",
    "image_generation": "image_generation",
    "timeline_generation": "timeline_generation",
    "timeline_consistency": "timeline_generation",
    "memory_summary": "memory_enrichment",
    "memory_autonomous_decision": "memory_enrichment",
    "social_group_reply": "social_generation",
    "social_timeline_comment": "social_generation",
    "semantic_verifier": "semantic_verification",
    "emotion_analysis": "emotion_analysis",
}

_CORE_PURPOSES = {
    "chat_reply",
}


class UsagePolicyDenied(PermissionError):
    """Raised before an optional AI/network side effect is allowed to start."""

    def __init__(self, feature: OptionalAIFeature, reason: str) -> None:
        self.feature = feature
        self.reason = reason
        super().__init__(f"{feature}: {reason}")


class UsagePolicyRevoked(asyncio.CancelledError):
    """An in-flight result became unusable because its consent was revoked."""

    def __init__(self, feature: OptionalAIFeature) -> None:
        self.feature = feature
        super().__init__(f"Consent for {feature} was revoked while work was running")


@dataclass(frozen=True)
class UsageLease:
    feature: OptionalAIFeature | None
    generation: int
    task: asyncio.Task | None


class UsagePolicy:
    """Central consent authority shared by every optional generation path."""

    def __init__(
        self,
        settings_provider: Callable[[], "_Settings"] | None = None,
        *,
        save_callback: Callable[["_Settings"], None] | None = None,
    ) -> None:
        if settings_provider is None:
            from .settings import load_settings, save_settings

            settings_provider = load_settings
            save_callback = save_callback or save_settings
        self._settings_provider = settings_provider
        self._save_callback = save_callback or (lambda _settings: None)
        self._lock = threading.RLock()
        self._generations: dict[OptionalAIFeature, int] = {
            feature: 0 for feature in FEATURE_DESCRIPTIONS
        }
        # A task may hold an outer feature lease while the shared adapter takes
        # one or more nested leases.  Reference counts keep the outer revoke
        # listener alive when an inner provider call finishes.
        self._tasks: dict[OptionalAIFeature, dict[asyncio.Task, int]] = {
            feature: {} for feature in FEATURE_DESCRIPTIONS
        }

    def feature_for_purpose(
        self,
        purpose: str,
        *,
        background: bool,
    ) -> OptionalAIFeature | None:
        normalized = str(purpose or "unspecified").strip().lower()
        mapped = PURPOSE_TO_FEATURE.get(normalized)
        if mapped is not None:
            return mapped
        if background:
            # Unknown background work fails closed instead of becoming a new
            # unlabelled billing path.
            return "other_background_generation"
        if normalized in _CORE_PURPOSES:
            return None
        # A new foreground purpose must be classified explicitly.  Treating it
        # as core chat by accident would silently broaden consent.
        return "other_background_generation"

    def description(self, feature: OptionalAIFeature) -> str:
        return FEATURE_DESCRIPTIONS[feature]

    def current_provider_binding(self) -> tuple[str, str]:
        """Return the provider and normalized origin shown during consent."""

        from .settings import PROVIDER_DEFAULTS

        settings = self._settings_provider()
        provider = str(settings.llm.provider or "").strip().lower()
        base_url = str(settings.llm.base_url or "").strip()
        if not base_url:
            base_url = str(PROVIDER_DEFAULTS.get(provider, {}).get("base_url") or "")
        try:
            parsed = urlsplit(base_url)
            scheme = parsed.scheme.lower()
            hostname = (parsed.hostname or "").lower().rstrip(".")
            if scheme not in {"http", "https"} or not hostname:
                return provider, ""
            port = parsed.port
        except (TypeError, ValueError):
            return provider, ""
        default_port = (scheme == "https" and port in {None, 443}) or (
            scheme == "http" and port in {None, 80}
        )
        authority = hostname if default_port else f"{hostname}:{port}"
        return provider, f"{scheme}://{authority}"

    def allowed(self, feature: OptionalAIFeature) -> bool:
        settings = self._settings_provider()
        grant = getattr(settings.ai_usage, feature)
        if not (grant.enabled and grant.api_cost_acknowledged):
            return False
        current_provider, current_origin = self.current_provider_binding()
        if (
            not current_origin
            or grant.provider != current_provider
            or grant.origin != current_origin
        ):
            return False
        features = settings.features
        required_switch = {
            "proactive_chat": features.proactive_chat_enabled,
            "diary_generation": features.diary_enabled,
            "web_access": features.web_surfing_enabled and features.web_disclaimer_acknowledged,
            "image_generation": True,
            "timeline_generation": features.timeline_enabled,
            "memory_enrichment": features.autonomous_memory_llm_enabled,
            "social_generation": features.group_social_api_replies_enabled,
            "semantic_verification": True,
            "emotion_analysis": features.emotion_system_enabled,
            "other_background_generation": True,
        }[feature]
        return bool(required_switch)

    def require(self, feature: OptionalAIFeature) -> None:
        settings = self._settings_provider()
        grant = getattr(settings.ai_usage, feature)
        if not grant.enabled:
            raise UsagePolicyDenied(feature, "该额外 AI/联网功能默认关闭，尚未由用户开启")
        if not grant.api_cost_acknowledged:
            raise UsagePolicyDenied(feature, "尚未确认此功能可能消耗 API 或网络资源")
        current_provider, current_origin = self.current_provider_binding()
        if (
            not current_origin
            or grant.provider != current_provider
            or grant.origin != current_origin
        ):
            raise UsagePolicyDenied(
                feature,
                "AI provider or destination changed; review and grant consent again",
            )
        if not self.allowed(feature):
            raise UsagePolicyDenied(feature, "对应功能开关、联网声明或本地配置尚未启用")

    def begin_for_purpose(self, purpose: str, *, background: bool) -> UsageLease:
        feature = self.feature_for_purpose(purpose, background=background)
        if feature is None:
            return UsageLease(feature=None, generation=0, task=None)
        return self.begin(feature)

    def begin(self, feature: OptionalAIFeature) -> UsageLease:
        self.require(feature)
        try:
            task = asyncio.current_task()
        except RuntimeError:
            task = None
        with self._lock:
            generation = self._generations[feature]
            if task is not None:
                self._tasks[feature][task] = self._tasks[feature].get(task, 0) + 1
        # Close the check/register race.  A concurrent revoke between the first
        # require and registration is visible through the generation and the
        # live grant check below.
        lease = UsageLease(feature=feature, generation=generation, task=task)
        self.validate(lease)
        return lease

    def validate(self, lease: UsageLease) -> None:
        if lease.feature is None:
            return
        with self._lock:
            current_generation = self._generations[lease.feature]
            if current_generation != lease.generation or not self.allowed(lease.feature):
                raise UsagePolicyRevoked(lease.feature)

    def commit(self, lease: UsageLease, callback: Callable[[], _T]) -> _T:
        """Linearize the final local commit against concurrent revocation."""

        if lease.feature is None:
            return callback()
        with self._lock:
            current_generation = self._generations[lease.feature]
            if current_generation != lease.generation or not self.allowed(lease.feature):
                raise UsagePolicyRevoked(lease.feature)
            return callback()

    def finish(self, lease: UsageLease) -> None:
        if lease.feature is None or lease.task is None:
            return
        with self._lock:
            count = self._tasks[lease.feature].get(lease.task, 0)
            if count <= 1:
                self._tasks[lease.feature].pop(lease.task, None)
            else:
                self._tasks[lease.feature][lease.task] = count - 1

    def revoke(self, feature: OptionalAIFeature) -> int:
        """Revoke immediately and cancel registered in-flight tasks.

        The settings object is replaced with a validated disabled grant before
        tasks are cancelled.  This means a caller that suppresses cancellation
        still fails the return-path lease check.
        """

        from .settings import AIFeatureConsent

        settings = self._settings_provider()
        with self._lock:
            setattr(settings.ai_usage, feature, AIFeatureConsent())
            self._generations[feature] += 1
            tasks = tuple(self._tasks[feature].keys())
            self._tasks[feature].clear()
        try:
            current = asyncio.current_task()
        except RuntimeError:
            current = None
        cancelled = 0
        for task in tasks:
            if task is current or task.done():
                continue
            task.cancel(f"Reverie consent revoked: {feature}")
            cancelled += 1
        # Revocation is fail-closed in memory even if durable storage is
        # temporarily unavailable.  Cancellation never depends on disk I/O.
        self._save_callback(settings)
        return cancelled

    def grant(self, feature: OptionalAIFeature) -> None:
        """Persist a deliberate user grant; UI must show ``description`` first."""

        from .settings import AIFeatureConsent

        with self._lock:
            settings = self._settings_provider()
            provider, origin = self.current_provider_binding()
            if not provider or not origin:
                raise UsagePolicyDenied(feature, "AI provider destination is invalid")
            previous = getattr(settings.ai_usage, feature)
            setattr(
                settings.ai_usage,
                feature,
                AIFeatureConsent(
                    enabled=True,
                    api_cost_acknowledged=True,
                    granted_at_utc=datetime.now(timezone.utc).isoformat(),
                    provider=provider,
                    origin=origin,
                ),
            )
            try:
                # A grant is not visible to new leases until it is durable.
                self._save_callback(settings)
            except BaseException:
                setattr(settings.ai_usage, feature, previous)
                raise
            self._generations[feature] += 1

    def revoke_all_for_provider_change(self) -> int:
        """Invalidate grants and in-flight work before a destination changes."""

        from .settings import AIFeatureConsent

        settings = self._settings_provider()
        with self._lock:
            tasks: set[asyncio.Task] = set()
            for feature in FEATURE_DESCRIPTIONS:
                setattr(settings.ai_usage, feature, AIFeatureConsent())
                self._generations[feature] += 1
                tasks.update(self._tasks[feature])
                self._tasks[feature].clear()
        try:
            current = asyncio.current_task()
        except RuntimeError:
            current = None
        cancelled = 0
        for task in tasks:
            if task is current or task.done():
                continue
            task.cancel("Reverie AI provider destination changed")
            cancelled += 1
        # Memory is fail-closed even if persisting the revocation fails.
        self._save_callback(settings)
        return cancelled

    def snapshot(self) -> dict[str, dict[str, object]]:
        settings = self._settings_provider()
        current_provider, current_origin = self.current_provider_binding()
        return {
            feature: {
                "enabled": bool(getattr(settings.ai_usage, feature).enabled),
                "api_cost_acknowledged": bool(
                    getattr(settings.ai_usage, feature).api_cost_acknowledged
                ),
                "effective": self.allowed(feature),
                "description": description,
                "provider": getattr(settings.ai_usage, feature).provider,
                "origin": getattr(settings.ai_usage, feature).origin,
                "current_provider": current_provider,
                "current_origin": current_origin,
            }
            for feature, description in FEATURE_DESCRIPTIONS.items()
        }


_GLOBAL_POLICY: UsagePolicy | None = None
_GLOBAL_POLICY_LOCK = threading.Lock()


def get_usage_policy() -> UsagePolicy:
    global _GLOBAL_POLICY
    if _GLOBAL_POLICY is None:
        with _GLOBAL_POLICY_LOCK:
            if _GLOBAL_POLICY is None:
                _GLOBAL_POLICY = UsagePolicy()
    return _GLOBAL_POLICY

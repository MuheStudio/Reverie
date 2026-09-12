"""Reverie configuration system.

Loads settings from .env (secrets) and data/config.json (user preferences).
Uses pydantic for validation.
"""

import json
import ipaddress
import logging
import os
import shutil
from datetime import datetime
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit, urlunsplit

from dotenv import load_dotenv
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

# ── Paths ──────────────────────────────────────────────────
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
DATA_DIR = Path(os.environ.get("REVERIE_DATA_DIR", PROJECT_ROOT / "data")).expanduser().resolve()
CONFIG_FILE = DATA_DIR / "config.json"
PERSONA_DIR = DATA_DIR / "persona"
MEMORY_DIR = DATA_DIR / "memory"
DIARY_DIR = DATA_DIR / "diary"
DIARY_KEY_DIR = DIARY_DIR / "keys"
STICKERS_DIR = DATA_DIR / "stickers"
BACKUPS_DIR = DATA_DIR / "backups"
TIMELINE_DIR = DATA_DIR / "timeline"
WEB_CACHE_DIR = DATA_DIR / "web_cache"
USER_DIR = DATA_DIR / "user"
SOCIAL_DIR = DATA_DIR / "social"
INTEREST_DIR = DATA_DIR / "interest"
AFFAIRS_DIR = DATA_DIR / "affairs"
WORLD_DIR = DATA_DIR / "world"
WORLD_STATE_DB = DATA_DIR / "world_state.sqlite3"
EMOTION_DIR = DATA_DIR / "emotion"
KEEPSAKE_DIR = DATA_DIR / "keepsakes"
RELATIONSHIP_DIR = DATA_DIR / "relationship"

# Load .env once at module level
load_dotenv(PROJECT_ROOT / ".env", override=True)

logger = logging.getLogger("reverie.config.settings")


# ── Provider info ──────────────────────────────────────────
ProviderName = Literal[
    "deepseek", "openai", "anthropic", "gemini", "grok",
    "kimi", "glm", "ollama", "custom",
]

# Public provider surface.  Every listed provider has an implementation in the
# shared adapter; do not add a label here without adding its transport there.
SUPPORTED_PROVIDER_NAMES: frozenset[ProviderName] = frozenset({
    "openai", "anthropic", "gemini", "grok", "deepseek", "kimi", "glm",
    "ollama", "custom",
})

PROVIDER_DEFAULTS: dict[ProviderName, dict] = {
    "deepseek":  {"base_url": "https://api.deepseek.com", "env_key": "DEEPSEEK_API_KEY"},
    "openai":    {"base_url": "https://api.openai.com/v1",   "env_key": "OPENAI_API_KEY"},
    "anthropic": {"base_url": "https://api.anthropic.com",    "env_key": "ANTHROPIC_API_KEY"},
    "gemini":    {"base_url": "https://generativelanguage.googleapis.com/v1beta/openai", "env_key": "GEMINI_API_KEY"},
    "grok":      {"base_url": "https://api.x.ai/v1",          "env_key": "XAI_API_KEY"},
    "kimi":      {"base_url": "https://api.moonshot.cn/v1",   "env_key": "KIMI_API_KEY"},
    "glm":       {"base_url": "https://api.z.ai/api/paas/v4", "env_key": "GLM_API_KEY"},
    "ollama":    {"base_url": "http://localhost:11434/v1",    "env_key": None},
    "custom":    {"base_url": "",                             "env_key": None},
}


def normalize_provider_endpoint(provider: ProviderName, requested: str | None) -> str:
    """Validate a model endpoint without performing DNS or network I/O.

    Named cloud providers are pinned to their published endpoint.  Ollama is
    the explicit loopback option.  A custom OpenAI-compatible endpoint must be
    HTTPS and may not embed credentials or target an obvious local/private IP.
    """

    default = str(PROVIDER_DEFAULTS[provider]["base_url"] or "").rstrip("/")
    candidate = str(requested or "").strip().rstrip("/")
    if provider not in {"custom", "ollama"}:
        if candidate and candidate != default:
            raise ValueError(f"{provider} endpoint is fixed and cannot be overridden")
        return default
    if not candidate:
        if provider == "ollama":
            candidate = default
        else:
            raise ValueError("custom provider requires an HTTPS base URL")
    if "\\" in candidate or any(char.isspace() for char in candidate):
        raise ValueError("provider endpoint contains invalid characters")
    try:
        parsed = urlsplit(candidate)
        port = parsed.port
    except ValueError as exc:
        raise ValueError("provider endpoint is invalid") from exc
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("provider endpoint must not contain credentials")
    if parsed.query or parsed.fragment:
        raise ValueError("provider endpoint must not contain query or fragment")
    hostname = (parsed.hostname or "").rstrip(".")
    if not hostname:
        raise ValueError("provider endpoint requires a hostname")
    try:
        ascii_hostname = hostname.encode("idna").decode("ascii").lower()
    except UnicodeError as exc:
        raise ValueError("provider endpoint hostname is invalid") from exc
    try:
        address = ipaddress.ip_address(ascii_hostname.split("%", 1)[0])
    except ValueError:
        address = None

    if provider == "ollama":
        if parsed.scheme not in {"http", "https"}:
            raise ValueError("Ollama endpoint must use HTTP or HTTPS")
        if ascii_hostname != "localhost" and not (address and address.is_loopback):
            raise ValueError("Ollama endpoint must remain on loopback")
    else:
        if parsed.scheme != "https":
            raise ValueError("custom provider endpoint must use HTTPS")
        if ascii_hostname == "localhost" or ascii_hostname.endswith(".local"):
            raise ValueError("custom provider endpoint may not target the local network")
        if address and not address.is_global:
            raise ValueError("custom provider endpoint may not target a private address")

    if ":" in ascii_hostname and not ascii_hostname.startswith("["):
        authority = f"[{ascii_hostname}]"
    else:
        authority = ascii_hostname
    if port is not None:
        authority = f"{authority}:{port}"
    path = parsed.path.rstrip("/")
    if "/../" in f"{path}/" or "/./" in f"{path}/":
        raise ValueError("provider endpoint path may not traverse directories")
    return urlunsplit((parsed.scheme.lower(), authority, path, "", ""))


# ── Settings models ────────────────────────────────────────

class _ValidatedSettingsModel(BaseModel):
    """Settings validate again on runtime assignment.

    The desktop settings bridge mutates the live models.  Without
    ``validate_assignment`` a value can pass the startup schema and then be
    replaced with an invalid value for the rest of the process lifetime.
    """

    model_config = ConfigDict(validate_assignment=True, extra="ignore")


class LLMSettings(_ValidatedSettingsModel):
    provider: ProviderName = Field(default="ollama")
    model: str = Field(default="")
    api_key: str = Field(default="")
    base_url: str = Field(default="")
    temperature: float = Field(default=0.82, ge=0.0, le=2.0)
    max_tokens: int = Field(default=2048)

    @model_validator(mode="after")
    def _migrate_deprecated_deepseek_models(self) -> "LLMSettings":
        if self.provider == "deepseek":
            replacement = {
                # DeepSeek retired these compatibility aliases on 2026-07-24.
                # V4 Flash is the closest current endpoint for both aliases;
                # users can explicitly select Pro in the desktop UI.
                "deepseek-chat": "deepseek-v4-flash",
                "deepseek-reasoner": "deepseek-v4-flash",
            }.get(self.model)
            if replacement:
                object.__setattr__(self, "model", replacement)
        return self

    def resolve(self) -> None:
        """Resolve defaults and credentials without overriding an explicit endpoint."""
        info = PROVIDER_DEFAULTS.get(self.provider, {})
        requested_base_url = str(self.base_url or "").strip()
        self.base_url = normalize_provider_endpoint(self.provider, self.base_url)
        # Always read API key from env if available (never trust cached config.json)
        env_key = info.get("env_key")
        if env_key:
            env_val = environment_api_key(str(env_key))
            if env_val:
                self.api_key = env_val
        # Ollama needs no API key.  An environment override remains subject to
        # the same loopback-only validation as a UI value.
        if self.provider == "ollama" and not requested_base_url:
            self.base_url = normalize_provider_endpoint(
                "ollama",
                os.getenv("OLLAMA_BASE_URL", self.base_url),
            )


_PLACEHOLDER_API_KEYS = {
    "changeme",
    "replace-me",
    "replace_me",
    "sk-your-key-here",
    "your-api-key",
    "your_api_key",
    "your_api_key_here",
}


def environment_api_key(variable: str) -> str:
    """Return a usable environment credential, never a template placeholder."""

    value = str(os.getenv(variable, "") or "").strip()
    if not value or value.lower() in _PLACEHOLDER_API_KEYS:
        return ""
    return value


class MemorySettings(_ValidatedSettingsModel):
    embedding_model: str = Field(default="BAAI/bge-small-zh-v1.5")
    vector_quantization: Literal["float32", "int8"] = Field(default="int8")
    vector_partitioning_enabled: bool = Field(default=True)
    lancedb_path: str = Field(default=str(MEMORY_DIR / "vectors"))
    sqlite_path: str = Field(default=str(MEMORY_DIR / "metadata.db"))
    # Retention: user questionnaire default
    retention_days: int = Field(default=365 * 2, ge=365, le=365 * 3)
    interaction_capture_enabled: bool = Field(default=True)
    short_term_capture_probability: float = Field(default=1.0, ge=0.01, le=1.0)
    # Forgetting
    forgetting_enabled: bool = Field(default=True)
    long_term_forgetting_enabled: bool = Field(default=True)
    short_term_forgetting_enabled: bool = Field(default=True)
    long_term_forget_days: int = Field(default=90, ge=60, le=365)
    short_term_forget_days: int = Field(default=7, ge=1, le=59)
    long_term_forget_probability: float = Field(default=0.05, ge=0.01, le=0.10)
    short_term_forget_probability: float = Field(default=0.05, ge=0.01, le=0.10)
    # Legacy fallback kept for older config files.
    forget_probability: float = Field(default=0.05, ge=0.01, le=0.10)
    # Retrieval decay. Defaults to a 90-day half-life before layer/salience scaling.
    decay_lambda: float = Field(default=0.0077, ge=0.0001, le=0.10)
    recall_reinforcement_alpha: float = Field(default=0.12, ge=0.0, le=0.50)
    minimum_retrieval_retention: float = Field(default=0.05, ge=0.0, le=0.95)
    # Misremembering (1%-10%, scaled by memory age inside the eligible window)
    misremembering_enabled: bool = Field(default=False)
    misremember_probability: float = Field(default=0.05, ge=0.01, le=0.10)
    long_term_misremembering_enabled: bool = Field(default=True)
    short_term_misremembering_enabled: bool = Field(default=True)
    long_term_misremember_probability: float = Field(default=0.05, ge=0.01, le=0.10)
    short_term_misremember_probability: float = Field(default=0.05, ge=0.01, le=0.10)
    # Lifecycle governance (P0): 驻留/查询分离 + 预算压力阀 + 引用反馈闭环。
    # 默认开；用户可在设置中关闭并保存。旧配置没有该键时走此默认值。
    memory_lifecycle_governance_enabled: bool = Field(default=True)
    memory_long_budget_chars: int = Field(default=250_000, ge=50_000, le=2_000_000)

    @field_validator("retention_days")
    @classmethod
    def _retention_is_explicit_year_choice(cls, value: int) -> int:
        if value not in {365, 365 * 2, 365 * 3}:
            raise ValueError("retention_days must be exactly 1, 2, or 3 years")
        return value


class ChatSettings(_ValidatedSettingsModel):
    reply_delay_min: float = Field(default=3.0, ge=1.0, le=60.0)
    reply_delay_max: float = Field(default=30.0, ge=1.0, le=60.0)
    split_messages: bool = Field(default=True)
    typing_indicator: bool = Field(default=True)
    allow_environment_description: bool = Field(default=False)
    status: Literal["online", "busy", "away", "sleeping"] = Field(default="online")

    @model_validator(mode="after")
    def _validate_reply_delay_order(self) -> "ChatSettings":
        if self.reply_delay_min > self.reply_delay_max:
            raise ValueError("reply_delay_min cannot exceed reply_delay_max")
        return self


class AIFeatureConsent(_ValidatedSettingsModel):
    """One explicit, revocable consent for an API-consuming optional feature."""

    enabled: bool = Field(default=False)
    api_cost_acknowledged: bool = Field(default=False)
    granted_at_utc: str = Field(default="", max_length=64)
    provider: str = Field(default="", max_length=32)
    origin: str = Field(default="", max_length=512)

    @model_validator(mode="after")
    def _enabled_requires_cost_acknowledgement(self) -> "AIFeatureConsent":
        if self.enabled and not self.api_cost_acknowledged:
            raise ValueError("AI feature consent requires API-cost acknowledgement")
        return self


class AIUsageSettings(_ValidatedSettingsModel):
    """Consent ledger for optional AI/network work.

    Core user-initiated chat remains independently configurable by the chosen
    provider.  Every optional/background generation path is deny-by-default and
    must name one of these grants at the shared adapter/network boundary.
    """

    proactive_chat: AIFeatureConsent = Field(default_factory=AIFeatureConsent)
    diary_generation: AIFeatureConsent = Field(default_factory=AIFeatureConsent)
    web_access: AIFeatureConsent = Field(default_factory=AIFeatureConsent)
    image_generation: AIFeatureConsent = Field(default_factory=AIFeatureConsent)
    timeline_generation: AIFeatureConsent = Field(default_factory=AIFeatureConsent)
    memory_enrichment: AIFeatureConsent = Field(default_factory=AIFeatureConsent)
    social_generation: AIFeatureConsent = Field(default_factory=AIFeatureConsent)
    semantic_verification: AIFeatureConsent = Field(default_factory=AIFeatureConsent)
    emotion_analysis: AIFeatureConsent = Field(default_factory=AIFeatureConsent)
    other_background_generation: AIFeatureConsent = Field(default_factory=AIFeatureConsent)


class FeatureSettings(_ValidatedSettingsModel):
    """User-facing feature switches for life-simulation systems."""

    web_surfing_enabled: bool = Field(default=False)
    web_disclaimer_acknowledged: bool = Field(default=False)
    web_native_search_enabled: bool = Field(default=False)
    surf_keyless_search_enabled: bool = Field(default=False)
    # Video download (cat-catch-inspired sniff/HLS pipeline; disclaimer-gated, default off).
    # Mirrors the web_surfing_enabled + web_disclaimer_acknowledged pairing: the feature
    # stays locked until the user reads the liability disclaimer and acknowledges it.
    video_download_enabled: bool = Field(default=False)
    video_download_disclaimer_acknowledged: bool = Field(default=False)
    video_max_size_mb: int = Field(default=500, ge=1, le=4096)
    video_max_duration_seconds: int = Field(default=1800, ge=1, le=21600)
    video_total_quota_mb: int = Field(default=4096, ge=1, le=51200)
    web_allowed_topics: list[str] = Field(default_factory=lambda: [
        "热门梗",
        "新番/动漫资讯",
        "二次元内容",
        "游戏更新",
    ])
    web_search_windows: list[str] = Field(default_factory=lambda: ["20:00-23:00"])
    web_refresh_interval_minutes: int = Field(default=180, ge=30, le=1440)
    diary_enabled: bool = Field(default=False)
    diary_privacy_enabled: bool = Field(default=True)
    diary_peek_enabled: bool = Field(default=True)
    timeline_enabled: bool = Field(default=True)
    proactive_chat_enabled: bool = Field(default=False)
    proactive_notifications_enabled: bool = Field(default=False)
    proactive_event_stories_enabled: bool = Field(default=False)
    proactive_daily_limit: int = Field(default=2, ge=1, le=12)
    proactive_min_interval_minutes: int = Field(default=120, ge=15, le=1440)
    proactive_wake_min_minutes: int = Field(default=2, ge=2, le=60)
    proactive_wake_max_minutes: int = Field(default=10, ge=2, le=60)
    late_night_enabled: bool = Field(default=False)
    late_night_probability: float = Field(default=0.10, ge=0.01, le=0.30)
    late_night_message_enabled: bool = Field(default=False)
    autonomous_memory_enabled: bool = Field(default=True)
    autonomous_memory_llm_enabled: bool = Field(default=False)
    self_growth_enabled: bool = Field(default=True)
    self_growth_from_web_enabled: bool = Field(default=False)
    self_growth_from_memory_enabled: bool = Field(default=True)
    self_growth_interval_days: int = Field(default=90, ge=30, le=365)
    personality_flaws_enabled: bool = Field(default=True)
    user_selected_flaws: str = Field(
        default="路痴、偶尔拖延、怕黑、丢三落四、看到可爱东西会忍不住保存截图"
    )
    personality_flaws_disclaimer_acknowledged: bool = Field(default=False)
    emotion_system_enabled: bool = Field(default=True)
    emotion_carryover_days: int = Field(default=3, ge=1, le=7)
    emotion_inertia_factor: float = Field(default=0.15, ge=0.01, le=0.60)
    world_life_enabled: bool = Field(default=True)
    ambient_presence_enabled: bool = Field(default=True)
    ambient_book_pages_per_hour: float = Field(default=2.5, ge=0.1, le=12.0)
    ambient_trace_interval_minutes: int = Field(default=180, ge=30, le=1440)
    ambient_offline_replay_max_days: int = Field(default=30, ge=1, le=90)
    ambient_sticky_notes_enabled: bool = Field(default=True)
    thought_of_you_enabled: bool = Field(default=True)
    thought_share_probability: float = Field(default=0.35, ge=0.0, le=1.0)
    thought_min_delay_minutes: int = Field(default=180, ge=30, le=4320)
    thought_max_delay_minutes: int = Field(default=1440, ge=60, le=10080)
    thought_share_start_hour: int = Field(default=17, ge=0, le=23)
    thought_share_end_hour: int = Field(default=24, ge=1, le=24)
    diary_key_easter_egg_enabled: bool = Field(default=True)
    diary_key_intimacy_threshold: int = Field(default=2000, ge=100, le=10000)
    diary_key_happy_days: int = Field(default=7, ge=3, le=30)
    diary_key_private_emotion_threshold: float = Field(default=60.0, ge=40.0, le=95.0)
    user_phrase_alignment_enabled: bool = Field(default=True)
    user_phrase_alignment_probability: float = Field(default=0.05, ge=0.0, le=0.20)
    user_phrase_min_count: int = Field(default=3, ge=2, le=20)
    local_care_reflex_probability: float = Field(default=0.35, ge=0.0, le=1.0)
    api_budget_tracking_enabled: bool = Field(default=True)
    api_background_budget_enforced: bool = Field(default=True)
    api_background_daily_request_budget: int = Field(default=60, ge=1, le=10000)
    api_background_daily_token_budget: int = Field(default=30000, ge=1000, le=10000000)
    # Loud per-request tripwire ("the bill was the only alarm" lesson): when a
    # single LLM request's estimated or measured prompt tokens reach this
    # value the adapter shouts in the log. 0 disables the sentinel. This is
    # an alarm, not a budget — it never blocks the request.
    api_cost_sentinel_tokens: int = Field(default=60000, ge=0, le=10000000)
    timeline_visuals_enabled: bool = Field(default=False)
    group_social_enabled: bool = Field(default=True)
    group_social_permanent_memory_enabled: bool = Field(default=True)
    group_social_api_replies_enabled: bool = Field(default=False)
    group_social_comment_probability: float = Field(default=0.65, ge=0.0, le=1.0)
    group_social_backchannel_probability: float = Field(default=0.15, ge=0.0, le=0.5)
    group_social_max_api_calls_per_action: int = Field(default=1, ge=0, le=3)
    keepsake_collection_enabled: bool = Field(default=True)
    keepsake_recall_probability: float = Field(default=0.05, ge=0.01, le=0.30)
    immersion_location_enabled: bool = Field(default=False)
    immersion_closeups_enabled: bool = Field(default=False)
    immersion_smart_home_enabled: bool = Field(default=False)
    immersion_location_radius_m: int = Field(default=1200, ge=300, le=5000)
    image_service_enabled: bool = Field(default=False)
    download_service_enabled: bool = Field(default=False)
    hypa_compression_enabled: bool = Field(default=False)
    neko_import_enabled: bool = Field(default=False)
    neko_import_source_dir: str = Field(default="", max_length=2048)

    @model_validator(mode="after")
    def _validate_dependent_ranges(self) -> "FeatureSettings":
        if self.thought_min_delay_minutes > self.thought_max_delay_minutes:
            raise ValueError("thought_min_delay_minutes cannot exceed thought_max_delay_minutes")
        if self.proactive_wake_min_minutes > self.proactive_wake_max_minutes:
            raise ValueError("proactive_wake_min_minutes cannot exceed proactive_wake_max_minutes")
        if not self.video_download_disclaimer_acknowledged and self.video_download_enabled:
            object.__setattr__(self, "video_download_enabled", False)
        return self


TTS_PROVIDER_ENV_KEYS = {
    "gemini": "GEMINI_API_KEY",
    "openai": "OPENAI_API_KEY",
}


class TTSSettings(_ValidatedSettingsModel):
    """Text-to-speech backend selection (non-secret parts only).

    Like LLMSettings, the API key is never persisted to config.json; it is
    resolved from the environment at runtime via :func:`environment_api_key`.
    Local GPT-SoVITS needs no key: the user runs official ``api_v2.py``.
    """

    provider: Literal["gemini", "openai", "gpt-sovits"] = Field(default="gpt-sovits")
    model: str = Field(default="")
    voice: str = Field(default="")
    enabled: bool = Field(default=True)
    base_url: str = Field(default="http://127.0.0.1:9880", max_length=128)

    @field_validator("base_url")
    @classmethod
    def _loopback_tts_url(cls, value: str) -> str:
        candidate = str(value or "").strip().rstrip("/") or "http://127.0.0.1:9880"
        parsed = urlsplit(candidate)
        hostname = (parsed.hostname or "").rstrip(".").lower()
        if (
            parsed.scheme != "http"
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
            or parsed.path not in {"", "/"}
            or hostname not in {"127.0.0.1", "localhost", "::1"}
        ):
            raise ValueError("GPT-SoVITS 必须绑定本机回环 http 地址")
        port = parsed.port or 9880
        host = "127.0.0.1" if hostname in {"127.0.0.1", "localhost"} else "[::1]"
        return f"http://{host}:{port}"

    @property
    def resolved_api_key(self) -> str:
        """Current environment credential for the selected hosted provider."""
        env_key = TTS_PROVIDER_ENV_KEYS.get(self.provider)
        if not env_key:
            return ""
        return environment_api_key(env_key)


class UISettings(_ValidatedSettingsModel):
    """Durable non-secret renderer preferences owned by the Python host."""

    onboarding_completed: bool = Field(default=False)
    onboarding_completed_at_utc: str = Field(default="", max_length=64)
    onboarding_version: int = Field(default=0, ge=0, le=100)
    onboarding_state: Literal[
        "not_started", "in_progress", "committing", "complete"
    ] = Field(default="not_started")
    onboarding_last_step: str = Field(default="", max_length=64)
    experience_mode: Literal["full", "core"] = Field(default="full")
    mode: Literal["mvp", "dream"] = Field(default="mvp")

    @model_validator(mode="after")
    def _validate_onboarding_tuple(self) -> "UISettings":
        known_steps = {
            "", "welcome", "mode", "profile", "deepseek", "optional-media",
            "features", "rooms", "cards", "location", "pet", "finish",
        }
        if self.onboarding_last_step not in known_steps:
            raise ValueError("onboarding_last_step is unknown")
        if self.onboarding_completed:
            # A completed user may replay the wizard; the flag only drops via
            # an explicit completed=false, so in-progress browsing is legal.
            if self.onboarding_state == "not_started":
                raise ValueError("completed onboarding must not be not_started")
            if self.onboarding_version < 2:
                raise ValueError("completed onboarding requires version 2+")
            if self.onboarding_state == "complete" and self.onboarding_last_step != "finish":
                raise ValueError("completed onboarding requires the finish step")
        elif self.onboarding_state == "complete":
            raise ValueError("complete onboarding state requires completed=true")
        if self.onboarding_state in {"in_progress", "committing"} and self.onboarding_version not in {2, 3}:
            raise ValueError("active onboarding requires version 2 or 3")
        return self


class _Settings(_ValidatedSettingsModel):
    """Top-level settings container."""
    llm: LLMSettings = Field(default_factory=LLMSettings)
    memory: MemorySettings = Field(default_factory=MemorySettings)
    chat: ChatSettings = Field(default_factory=ChatSettings)
    features: FeatureSettings = Field(default_factory=FeatureSettings)
    tts: TTSSettings = Field(default_factory=TTSSettings)
    ui: UISettings = Field(default_factory=UISettings)
    ai_usage: AIUsageSettings = Field(default_factory=AIUsageSettings)
    # Cloud service mode: "local" (default) or "cloud" (future)
    cloud_mode: Literal["local", "cloud"] = Field(default="local")


# ── Singleton ──────────────────────────────────────────────

_settings: _Settings | None = None


def load_settings() -> _Settings:
    """Load configuration from disk, falling back to defaults."""
    global _settings
    if _settings is not None:
        return _settings

    settings = _Settings()

    # Merge from config.json if present
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            _migrate_legacy_memory_settings(data)
            settings = _Settings(**data)
        except Exception as exc:
            backup_path = _backup_invalid_config(CONFIG_FILE)
            logger.warning(
                "Invalid config file %s; using defaults. Backup: %s. Error: %s",
                CONFIG_FILE,
                backup_path or "not created",
                exc,
            )

    # Resolve provider info from .env.  A poisoned or obsolete endpoint must
    # disable only model configuration, not erase unrelated local settings.
    try:
        settings.llm.resolve()
    except ValueError as exc:
        logger.warning("Unsafe LLM endpoint rejected; model settings reset: %s", exc)
        settings.llm = LLMSettings()
        settings.llm.resolve()
    # Web pages are untrusted reference material and may never mutate persona memory.
    settings.features.self_growth_from_web_enabled = False

    # Ensure directories exist
    for d in [
        PERSONA_DIR,
        MEMORY_DIR,
        DIARY_DIR,
        DIARY_KEY_DIR,
        STICKERS_DIR,
        BACKUPS_DIR,
        TIMELINE_DIR,
        WEB_CACHE_DIR,
        USER_DIR,
        SOCIAL_DIR,
        INTEREST_DIR,
        AFFAIRS_DIR,
        WORLD_DIR,
        EMOTION_DIR,
        KEEPSAKE_DIR,
        RELATIONSHIP_DIR,
    ]:
        try:
            d.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            # An optional module's unavailable storage must not prevent core
            # settings/persona/chat from starting.  The owning capability will
            # report its own unavailable state when used.
            logger.warning("Optional data directory unavailable: %s (%s)", d, exc)

    _settings = settings
    return settings


def _migrate_legacy_memory_settings(data: object) -> None:
    """Clamp pre-2.1 confusion rates into the current valid range."""
    if not isinstance(data, dict):
        return
    ui = data.get("ui")
    if isinstance(ui, dict) and ui.get("onboarding_completed") is True:
        # Pre-v2 installs had only one completion boolean. Preserve those users
        # as completed rather than forcing the new wizard after an upgrade.
        ui.setdefault("onboarding_version", 2)
        ui.setdefault("onboarding_state", "complete")
        ui.setdefault("onboarding_last_step", "finish")
    memory = data.get("memory")
    if not isinstance(memory, dict):
        return
    for key in (
        "misremember_probability",
        "long_term_misremember_probability",
        "short_term_misremember_probability",
        "short_term_forget_probability",
        "long_term_forget_probability",
    ):
        if key not in memory:
            continue
        try:
            value = float(memory[key])
        except (TypeError, ValueError):
            memory[key] = 0.05
            continue
        memory[key] = min(0.10, max(0.01, value))


def _backup_invalid_config(path: Path) -> Path | None:
    """Keep a copy of an unreadable config before falling back to defaults."""
    try:
        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup_path = path.with_name(f"{path.stem}.invalid.{timestamp}{path.suffix}")
        shutil.copy2(path, backup_path)
        return backup_path
    except Exception:
        logger.exception("Failed to back up invalid config file: %s", path)
        return None


def save_settings(settings: _Settings) -> None:
    """Persist current settings to config.json. API key is NEVER saved to disk."""
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    data = settings.model_dump()
    # Security: api_key lives in .env only — never persist it
    data.get("llm", {}).pop("api_key", None)
    # A crash or forced shutdown must leave either the old complete file or the
    # new complete file, never a partially written consent/configuration file.
    temp_path = CONFIG_FILE.with_name(f".{CONFIG_FILE.name}.tmp")
    with open(temp_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.replace(temp_path, CONFIG_FILE)
    global _settings
    _settings = settings

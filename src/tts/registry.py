"""TTS provider registry.

Portable subset of the N.E.K.O tts_client design (Apache-2.0): a declarative
registry of TTS backends. Each provider declares a *factory* that builds a
configured synthesizer from settings, so the registry stays static while the
actual workers are constructed per-configuration.

MIT/Apache-2.0 derived design; all code here is original.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable

SynthesizeFn = Callable[[str, str], Awaitable[bytes]]
WorkerFactory = Callable[[dict[str, Any]], SynthesizeFn]


class TTSUnavailableError(RuntimeError):
    """The selected TTS provider is not configured/usable."""


@dataclass(frozen=True)
class TTSProvider:
    key: str
    label: str
    kind: str  # "hosted" | "local"
    voice_options: tuple[str, ...]
    is_selected: Callable[[dict[str, Any]], bool]
    build: WorkerFactory


_REGISTRY: dict[str, TTSProvider] = {}


def register(provider: TTSProvider) -> None:
    if provider.key in _REGISTRY:
        raise ValueError(f"TTS provider already registered: {provider.key}")
    _REGISTRY[provider.key] = provider


def registered_providers() -> list[TTSProvider]:
    return list(_REGISTRY.values())


def resolve_selected(settings: dict[str, Any]) -> TTSProvider | None:
    """Pick the first registered provider whose selection predicate matches."""
    for provider in _REGISTRY.values():
        try:
            if provider.is_selected(settings):
                return provider
        except Exception:
            continue
    return None


def build_selected(settings: dict[str, Any]) -> SynthesizeFn | None:
    """Resolve the active provider and build its configured synthesizer."""
    provider = resolve_selected(settings)
    if provider is None:
        return None
    return provider.build(settings)

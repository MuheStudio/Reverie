"""Ollama local model client — thin wrapper for model management.

Used for listing available local models and pulling new ones.
The actual chat calls go through the unified LLMAdapter (Ollama v0.5+
is OpenAI-compatible).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

logger = logging.getLogger("reverie.api.ollama")


@dataclass
class LocalModel:
    name: str
    size_bytes: int = 0
    modified_at: str = ""


async def list_models(base_url: str = "http://localhost:11434") -> list[LocalModel]:
    """Query Ollama for locally installed models."""
    try:
        import httpx
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"{base_url.rstrip('/')}/api/tags", timeout=10)
            resp.raise_for_status()
            data = resp.json()
            return [
                LocalModel(
                    name=m["name"],
                    size_bytes=m.get("size", 0),
                    modified_at=m.get("modified_at", ""),
                )
                for m in data.get("models", [])
            ]
    except Exception:
        logger.debug("Ollama not reachable — skipping model list", exc_info=True)
        return []


async def pull_model(model_name: str, base_url: str = "http://localhost:11434") -> bool:
    """Pull a model from Ollama registry. Returns True on success."""
    try:
        import httpx
        async with httpx.AsyncClient(timeout=600) as client:
            resp = await client.post(
                f"{base_url.rstrip('/')}/api/pull",
                json={"name": model_name, "stream": False},
            )
            return resp.status_code == 200
    except Exception:
        logger.exception("Failed to pull model %s", model_name)
        return False

"""Local GPT-SoVITS v2 worker (user-run api_v2.py on loopback).

Reverie never ships GPT-SoVITS weights or the inference runtime. The user
imports a four-file v2 pack (already copied under ``{userData}/voice-packs``)
and starts the official API themselves. This worker only:

1. Reads the active pack from disk (same layout Electron writes).
2. Calls loopback ``/set_gpt_weights``, ``/set_sovits_weights``, ``POST /tts``.

The official default bind is ``127.0.0.1:9880``. Non-loopback base URLs are
rejected (SSRF).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx

from ..registry import SynthesizeFn, TTSProvider, TTSUnavailableError, register

logger = logging.getLogger("reverie.tts.gpt_sovits")

DEFAULT_BASE_URL = "http://127.0.0.1:9880"
ACTIVE_SCHEMA = "reverie.voice-pack-active.v1"
MANIFEST_SCHEMA = "reverie.voice-pack.v1"
RUNTIME_FAMILY = "gpt-sovits"
RUNTIME_VERSION = "v2"
_UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
_MAX_TEXT_CHARS = 1_000
_WEIGHTS_TIMEOUT = 60.0
_TTS_TIMEOUT = 120.0
_loaded_pack_id: str | None = None
_synthesize_lock = asyncio.Lock()


def _data_dir() -> Path:
    raw = os.environ.get("REVERIE_DATA_DIR")
    if raw:
        return Path(raw).expanduser().resolve()
    return Path(__file__).resolve().parents[3] / "data"


def voice_packs_root(data_dir: Path | None = None) -> Path:
    """Electron stores packs next to ``userData/data``, not inside it."""
    return (data_dir or _data_dir()).resolve().parent / "voice-packs"


def loopback_base_url(raw: str | None) -> str:
    candidate = str(raw or DEFAULT_BASE_URL).strip().rstrip("/")
    if not candidate:
        candidate = DEFAULT_BASE_URL
    parsed = urlsplit(candidate)
    if parsed.scheme != "http":
        raise TTSUnavailableError("GPT-SoVITS 只允许本机 http 地址")
    if parsed.username is not None or parsed.password is not None:
        raise TTSUnavailableError("GPT-SoVITS 地址不能包含凭据")
    if parsed.query or parsed.fragment:
        raise TTSUnavailableError("GPT-SoVITS 地址不能包含查询或片段")
    hostname = (parsed.hostname or "").rstrip(".").lower()
    if hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise TTSUnavailableError("GPT-SoVITS 必须绑定本机回环地址")
    if parsed.path not in {"", "/"}:
        raise TTSUnavailableError("GPT-SoVITS 地址不能包含路径")
    port = parsed.port or 9880
    host = "127.0.0.1" if hostname in {"127.0.0.1", "localhost"} else "[::1]"
    return f"http://{host}:{port}"


def infer_lang(text: str) -> str:
    if any("\u4e00" <= char <= "\u9fff" for char in text):
        return "zh"
    if any("\u3040" <= char <= "\u30ff" for char in text):
        return "ja"
    return "en"


def load_active_voice_pack(data_dir: Path | None = None) -> dict[str, Any] | None:
    root = voice_packs_root(data_dir)
    active_path = root / "active.json"
    try:
        active = json.loads(active_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, json.JSONDecodeError) as exc:
        raise TTSUnavailableError("当前语音包索引损坏") from exc
    if not isinstance(active, dict) or active.get("schema") != ACTIVE_SCHEMA:
        raise TTSUnavailableError("当前语音包索引无效")
    pack_id = active.get("id")
    if pack_id is None:
        return None
    if not isinstance(pack_id, str) or not _UUID_PATTERN.fullmatch(pack_id):
        raise TTSUnavailableError("当前语音包编号无效")
    record = root / pack_id
    manifest_path = record / f"{MANIFEST_SCHEMA}.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise TTSUnavailableError("语音包清单无法读取") from exc
    if (
        not isinstance(manifest, dict)
        or manifest.get("schema") != MANIFEST_SCHEMA
        or manifest.get("id") != pack_id
        or manifest.get("runtime", {}).get("family") != RUNTIME_FAMILY
        or manifest.get("runtime", {}).get("version") != RUNTIME_VERSION
        or not isinstance(manifest.get("files"), list)
    ):
        raise TTSUnavailableError("语音包清单无效")
    files = {str(entry.get("role")): entry for entry in manifest["files"] if isinstance(entry, dict)}
    required = ("gptCheckpoint", "sovitsCheckpoint", "referenceAudio", "transcript")
    paths: dict[str, Path] = {}
    for role in required:
        entry = files.get(role)
        name = str((entry or {}).get("originalName") or "")
        if not entry or not name or "/" in name or "\\" in name or name in {".", ".."}:
            raise TTSUnavailableError(f"语音包缺少 {role}")
        payload = (record / "payload" / name).resolve()
        if payload.parent != (record / "payload").resolve() or not payload.is_file():
            raise TTSUnavailableError(f"语音包文件缺失：{role}")
        paths[role] = payload
    transcript_text = paths["transcript"].read_text(encoding="utf-8").strip()
    return {
        "id": pack_id,
        "gpt": paths["gptCheckpoint"],
        "sovits": paths["sovitsCheckpoint"],
        "reference": paths["referenceAudio"],
        "prompt_text": transcript_text,
        "prompt_lang": infer_lang(transcript_text),
    }


def _is_selected(settings: dict[str, Any]) -> bool:
    return str(settings.get("provider") or "") == "gpt-sovits"


def build_gpt_sovits_worker(settings: dict[str, Any]) -> SynthesizeFn:
    base_url = loopback_base_url(str(settings.get("base_url") or DEFAULT_BASE_URL))
    data_dir = Path(settings["data_dir"]) if settings.get("data_dir") else None

    async def synthesize(text: str, _voice: str) -> bytes:
        global _loaded_pack_id
        packed = load_active_voice_pack(data_dir)
        if packed is None:
            raise TTSUnavailableError("还没有可用的 GPT-SoVITS 语音包，请先在引导或设置里导入")
        if len(text) > _MAX_TEXT_CHARS:
            text = text[:_MAX_TEXT_CHARS]
        body = {
            "text": text,
            "text_lang": infer_lang(text),
            "ref_audio_path": str(packed["reference"]),
            "prompt_text": packed["prompt_text"],
            "prompt_lang": packed["prompt_lang"],
            "text_split_method": "cut0",
            "batch_size": 1,
            "media_type": "wav",
            "streaming_mode": False,
        }
        async with _synthesize_lock:
            try:
                async with httpx.AsyncClient(timeout=_TTS_TIMEOUT) as client:
                    if _loaded_pack_id != packed["id"]:
                        gpt_resp = await client.get(
                            f"{base_url}/set_gpt_weights",
                            params={"weights_path": str(packed["gpt"])},
                            timeout=_WEIGHTS_TIMEOUT,
                        )
                        sovits_resp = await client.get(
                            f"{base_url}/set_sovits_weights",
                            params={"weights_path": str(packed["sovits"])},
                            timeout=_WEIGHTS_TIMEOUT,
                        )
                        if gpt_resp.status_code >= 400 or sovits_resp.status_code >= 400:
                            logger.warning(
                                "GPT-SoVITS weight switch failed gpt=%s sovits=%s",
                                gpt_resp.status_code,
                                sovits_resp.status_code,
                            )
                        else:
                            _loaded_pack_id = packed["id"]
                    response = await client.post(f"{base_url}/tts", json=body)
                    response.raise_for_status()
            except httpx.ConnectError as exc:
                raise TTSUnavailableError(
                    "未检测到本机 GPT-SoVITS（默认 127.0.0.1:9880）。"
                    "请先启动官方 api_v2.py，再打开朗读。"
                ) from exc
            except httpx.HTTPError as exc:
                raise TTSUnavailableError("GPT-SoVITS 推理失败") from exc
        content_type = (response.headers.get("content-type") or "").lower()
        if "application/json" in content_type:
            raise TTSUnavailableError("GPT-SoVITS 拒绝了这次合成")
        audio = response.content
        if not audio:
            raise TTSUnavailableError("GPT-SoVITS 没有返回音频")
        return audio

    return synthesize


def register_gpt_sovits() -> None:
    register(
        TTSProvider(
            key="gpt-sovits",
            label="GPT-SoVITS v2（本机）",
            kind="local",
            voice_options=(),
            is_selected=_is_selected,
            build=build_gpt_sovits_worker,
        )
    )

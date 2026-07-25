"""Sticker system — kaomoji & emoji expression library.

Per requirements #59-66:
  - Default library of kaomoji (text-based, terminal-friendly)
  - Multi-tag emotion indexing
  - Collection of user-sent stickers (#60)
  - Emotion-based retrieval (#63)
  - Preference analysis via user profile (#65-66)
  - Reuse tracking (#64)

Stored as JSON: data/stickers/library.json (defaults + collected)
"""

from __future__ import annotations

import base64
import colorsys
import io
import json
import logging
import random
import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING

from ..config.settings import STICKERS_DIR

if TYPE_CHECKING:
    from ..user import UserManager

logger = logging.getLogger("reverie.stickers")

MAX_STICKER_DATA_URL_BYTES = 2_500_000
ALLOWED_STICKER_IMAGE_TYPES = {"png", "jpeg", "jpg", "webp", "gif"}

_EMOTION_COMPANIONS = {
    "joy": "excitement",
    "calm": "joy",
    "excitement": "joy",
    "sadness": "grievance",
    "anger": "anxiety",
    "anxiety": "grievance",
    "grievance": "sadness",
    "touched": "joy",
}


def _safe_string_list(value: object, *, limit: int = 12) -> list[str]:
    if isinstance(value, str):
        raw_items = value.replace("，", ",").replace("、", ",").split(",")
    elif isinstance(value, list):
        raw_items = value
    else:
        return []
    items: list[str] = []
    for item in raw_items:
        text = str(item).strip().lower()
        if text and text not in items:
            items.append(text[:32])
        if len(items) >= limit:
            break
    return items


def _validate_image_data_url(value: str) -> str:
    text = value.strip()
    if not text:
        return ""
    match = re.fullmatch(r"data:image/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)", text)
    if not match or match.group(1).lower() not in ALLOWED_STICKER_IMAGE_TYPES:
        raise ValueError("表情包图片仅支持 PNG、JPEG、WebP 或 GIF")
    if len(text.encode("utf-8")) > MAX_STICKER_DATA_URL_BYTES:
        raise ValueError("表情包图片过大")
    try:
        raw = base64.b64decode(match.group(2), validate=True)
    except Exception as exc:
        raise ValueError("表情包图片数据无效") from exc
    declared = match.group(1).lower()
    signatures = {
        "png": raw.startswith(b"\x89PNG\r\n\x1a\n"),
        "jpeg": raw.startswith(b"\xff\xd8\xff"),
        "jpg": raw.startswith(b"\xff\xd8\xff"),
        "gif": raw.startswith((b"GIF87a", b"GIF89a")),
        "webp": len(raw) >= 12 and raw.startswith(b"RIFF") and raw[8:12] == b"WEBP",
    }
    if not signatures.get(declared, False):
        raise ValueError("表情包图片内容与声明格式不一致")
    return text


def _expand_emotion_tags(tags: list[str]) -> list[str]:
    expanded = _safe_string_list(tags)
    if len(expanded) == 1:
        companion = _EMOTION_COMPANIONS.get(expanded[0])
        if companion:
            expanded.append(companion)
    return expanded or ["joy", "excitement"]


# ── Data structures ───────────────────────────────────────

@dataclass
class Sticker:
    """A single sticker / kaomoji or image sticker."""
    id: str
    text: str                                # the kaomoji / emoji text (or caption for images)
    emotions: list[str]                      # multi-tag e.g. ["joy","excitement"]
    source: str = "default"                  # "default" | "collected"
    usage_count: int = 0
    last_used: str = ""                      # ISO timestamp
    image_path: str = ""                     # local file path for image stickers (empty = text-only)
    image_data_url: str = ""                 # user-provided image data URL for frontend rendering
    style_tags: list[str] = field(default_factory=list)
    favorite_score: float = 1.0

    @property
    def is_image(self) -> bool:
        return bool(self.image_path or self.image_data_url)

    def to_dict(self) -> dict:
        d = {
            "id": self.id,
            "text": self.text,
            "emotions": self.emotions,
            "source": self.source,
            "usage_count": self.usage_count,
            "last_used": self.last_used,
            "image_path": self.image_path,
            "image_data_url": self.image_data_url,
            "style_tags": self.style_tags,
            "favorite_score": self.favorite_score,
        }
        return d

    @classmethod
    def from_dict(cls, data: dict) -> "Sticker":
        return cls(
            id=data.get("id", ""),
            text=data.get("text", ""),
            emotions=data.get("emotions", []),
            source=data.get("source", "default"),
            usage_count=data.get("usage_count", 0),
            last_used=data.get("last_used", ""),
            image_path=data.get("image_path", ""),
            image_data_url=data.get("image_data_url", ""),
            style_tags=_safe_string_list(data.get("style_tags", [])),
            favorite_score=float(data.get("favorite_score", 1.0) or 1.0),
        )


# ── Default kaomoji library ───────────────────────────────

# Emotion → list of kaomoji
DEFAULT_KAOMOJI: dict[str, list[str]] = {
    "joy": [
        "(｡•̀ᴗ-)✧", "(*^▽^*)", "(≧▽≦)", "｡ﾟ+.ﾟ(′▽`ʃ♡ƪ)ﾟ+.ﾟ",
        "✧◝(⁰▿⁰)◜✧", "(◍•ᴗ•◍)❤", "°˖✧◝(⁰▿⁰)◜✧˖°",
        "(ﾉ◕ヮ◕)ﾉ*:･ﾟ✧", "╰(✿´⌣`✿)╯",
    ],
    "calm": [
        "(´-ω-`)", "(￣▽￣*)ゞ", "(◡‿◡✿)", "(ᵕᴗᵕ✿)",
        "zzz...(_ _).｡o○", "( -_-)旦~", "〜(꒪꒳꒪)〜",
    ],
    "excitement": [
        "＼(≧▽≦)／", "ヾ( ˃ᴗ˂ )◞ • *✰", "ヽ(>∀<☆)ノ",
        "(☞ﾟヮﾟ)☞", "♪(๑ᴖ◡ᴖ๑)♪", "٩(◕‿◕｡)۶",
    ],
    "sadness": [
        "(╥﹏╥)", "(｡•́︿•̀｡)", "(´;︵;`)", "(个_个)",
        "(｡╯︵╰｡)", "(´•̥̥̥̥̥̥̥ ﹏ •̥̥̥̥̥̥̥` )",
        "o(╥﹏╥)o",
    ],
    "anger": [
        "(╬ Ò﹏Ó)", "(◣_◢)", "٩(╬ʘ益ʘ╬)۶", "(#｀皿´)",
        "(╯°□°)╯︵ ┻━┻", "୧(＾ 〰 ＾)୨",
    ],
    "anxiety": [
        "(;´･ω･)", "(◎﹏◎)", "(・_・;)", "(;⌣́_⌣̀)",
        "(￣ω￣;)", "(◎ロ◎;)", "Σ(°△°|||)︴",
    ],
    "grievance": [
        "(´-ω-`)...", "(｡•́︿•̀｡)", "｡ﾟ(｡ﾉωヽ｡)ﾟ｡",
        "(ﾉД`)", "(´ε｀；)",
    ],
    "touched": [
        "(´；ω；`)", "(ﾉД`)ｼｸｼｸ", "(｡>﹏<｡)",
        "(♡˙︶˙♡)", "(⁄ ⁄>⁄ ▽ ⁄<⁄ ⁄)", "｡ﾟ(ﾟ´Д｀ﾟ)ﾟ｡",
    ],
}


# ── StickerManager ────────────────────────────────────────

class StickerManager:
    """Manages the sticker library — defaults, collection, retrieval.

    Usage::

        stickers = StickerManager(user_manager)
        sticker = stickers.pick_for_emotion("joy")
        stickers.record_use(sticker)
    """

    def __init__(
        self,
        user_manager: "UserManager | None" = None,
        data_dir: Path | None = None,
    ) -> None:
        self.user_manager = user_manager
        self.data_dir = data_dir or STICKERS_DIR
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self._stickers: dict[str, Sticker] = {}
        self._style_preferences: dict[str, float] = {}
        self._load_defaults()
        self._load_preferences()

    # ── Retrieval (#63) ───────────────────────────────────

    def pick_for_emotion(self, emotion: str, top_k: int = 3) -> list[Sticker]:
        """Return stickers matching an emotion, sorted by preference weight.

        Top candidates are shuffled for variety.
        """
        matches = [
            s for s in self._stickers.values()
            if emotion in s.emotions
        ]
        if not matches:
            # Fallback: return any sticker
            matches = list(self._stickers.values())

        pref_weight = self.user_manager.get_sticker_weight(emotion) if self.user_manager else 1.0
        matches.sort(
            key=lambda s: (
                (pref_weight if emotion in s.emotions else 0.6)
                + max((self._style_preferences.get(tag, 0.0) for tag in s.style_tags), default=0.0)
                + min(s.usage_count, 20) * 0.02
                + max(0.0, s.favorite_score - 1.0)
            ),
            reverse=True,
        )

        # Pick from top_k with some randomness
        pool = matches[: max(3, min(len(matches), top_k))]
        random.shuffle(pool)
        return pool[: min(3, len(pool))]

    def get_random(self) -> Sticker | None:
        """Return a completely random sticker."""
        all_s = list(self._stickers.values())
        return random.choice(all_s) if all_s else None

    def get_by_id(self, sticker_id: str) -> Sticker | None:
        return self._stickers.get(sticker_id)

    def list_items(self, limit: int = 100) -> list[Sticker]:
        """Return recent collected stickers first, then defaults."""
        items = sorted(
            self._stickers.values(),
            key=lambda s: (
                s.source != "collected",
                -(s.usage_count or 0),
                s.id,
            ),
        )
        return items[: max(1, min(500, int(limit)))]

    # ── Collection (#60) ──────────────────────────────────

    def collect(
        self,
        text: str,
        emotions: list[str] | None = None,
        *,
        image_data_url: str = "",
        style_tags: list[str] | None = None,
    ) -> Sticker:
        """Add a new sticker to the collection (e.g., from user input)."""
        sid = f"col_{int(datetime.now().timestamp() * 1000)}_{len(self._stickers)}"
        clean_text = text.strip()[:120]
        clean_image = _validate_image_data_url(image_data_url)
        inferred_emotions = self._infer_emotions(clean_text, fallback=not bool(emotions))
        image_emotions = self._infer_image_emotions(clean_image) if clean_image else []
        clean_emotions = _expand_emotion_tags([*(emotions or []), *inferred_emotions, *image_emotions])
        clean_styles = _safe_string_list([*(style_tags or []), *self._infer_style_tags(clean_text)])
        if not clean_text and not clean_image:
            raise ValueError("表情包必须包含文字或本地图片")
        sticker = Sticker(
            id=sid,
            text=clean_text,
            emotions=clean_emotions or ["joy"],
            source="collected",
            image_data_url=clean_image,
            style_tags=clean_styles,
        )
        self._stickers[sid] = sticker
        self._save()
        logger.info("Collected sticker: %s", clean_text[:30])
        return sticker

    def record_user_sent(self, payload: dict) -> Sticker:
        """Collect or reuse a sticker sent by the user and learn from that act."""
        sticker_id = str(payload.get("id", "")).strip()
        sticker = self._stickers.get(sticker_id) if sticker_id else None
        if sticker is None:
            sticker = self.collect(
                text=str(payload.get("text", "")),
                emotions=payload.get("emotions") if isinstance(payload.get("emotions"), list) else None,
                image_data_url=str(payload.get("image_data_url", "")),
                style_tags=payload.get("style_tags") if isinstance(payload.get("style_tags"), list) else None,
            )
        sticker.favorite_score = min(3.0, sticker.favorite_score + 0.05)
        for emotion in sticker.emotions:
            if self.user_manager:
                self.user_manager.record_sticker_use(emotion, delta=0.08)
        self.record_style_preference(sticker.style_tags, delta=0.08)
        self._save()
        return sticker

    # ── Tracking (#64) ────────────────────────────────────

    def record_use(self, sticker: Sticker) -> None:
        """Record that a sticker was used (increments counter, updates timestamp)."""
        sticker.usage_count += 1
        sticker.last_used = datetime.now().isoformat()
        if sticker.id in self._stickers:
            self._save()

    def record_style_preference(self, style_tags: list[str], *, delta: float = 0.08) -> None:
        """Track broad sticker preferences such as cats/anime/memes."""
        changed = False
        for tag in _safe_string_list(style_tags):
            self._style_preferences[tag] = min(5.0, max(0.0, self._style_preferences.get(tag, 0.0) + delta))
            changed = True
        if changed:
            self._save_preferences()

    def record_user_feedback(self, sticker_id: str, liked: bool = True) -> Sticker | None:
        """Record explicit user feedback on a sticker."""
        sticker = self._stickers.get(sticker_id)
        if not sticker:
            return None
        sticker.favorite_score = min(3.0, sticker.favorite_score + 0.15) if liked else max(0.2, sticker.favorite_score - 0.2)
        if self.user_manager:
            for emotion in sticker.emotions:
                self.user_manager.record_sticker_use(emotion, delta=0.12 if liked else -0.10)
        self.record_style_preference(sticker.style_tags, delta=0.12 if liked else -0.05)
        self._save()
        return sticker

    # ── Persistence ───────────────────────────────────────

    def _load_defaults(self) -> None:
        """Load default kaomoji library + any saved collection."""
        filepath = self.data_dir / "library.json"
        if filepath.exists():
            try:
                with open(filepath, "r", encoding="utf-8") as f:
                    data = json.load(f)
                for s_data in data:
                    s = Sticker.from_dict(s_data)
                    s.emotions = _expand_emotion_tags(s.emotions)
                    self._stickers[s.id] = s
                self._save()
                return
            except Exception:
                logger.exception("Failed to load sticker library, rebuilding defaults")

        # Build from defaults
        sid = 0
        for emotion, kaomojis in DEFAULT_KAOMOJI.items():
            for kao in kaomojis:
                sticker = Sticker(
                    id=f"def_{sid}",
                    text=kao,
                    emotions=_expand_emotion_tags([emotion]),
                    source="default",
                )
                self._stickers[sticker.id] = sticker
                sid += 1
        self._save()

    def _save(self) -> None:
        filepath = self.data_dir / "library.json"
        data = [s.to_dict() for s in self._stickers.values()]
        _atomic_write_json(filepath, data)

    def _load_preferences(self) -> None:
        filepath = self.data_dir / "preferences.json"
        if not filepath.exists():
            return
        try:
            data = json.loads(filepath.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                self._style_preferences = {
                    str(key).strip().lower(): float(value)
                    for key, value in data.get("style_tags", {}).items()
                    if str(key).strip()
                }
        except Exception:
            logger.exception("Failed to load sticker preferences")
            self._style_preferences = {}

    def _save_preferences(self) -> None:
        filepath = self.data_dir / "preferences.json"
        data = {"style_tags": self._style_preferences}
        _atomic_write_json(filepath, data)

    def _infer_emotions(self, text: str, *, fallback: bool = True) -> list[str]:
        """Rough emotion inference from kaomoji text content."""
        emotions = []
        lowered = text.lower()
        keyword_map = {
            "joy": ["开心", "快乐", "哈哈", "好耶", "笑", "喜欢", "可爱"],
            "touched": ["安慰", "抱抱", "感动", "陪", "心疼"],
            "sadness": ["难过", "累", "哭", "失落", "瘫倒", "委屈"],
            "anger": ["生气", "火大", "气", "哼"],
            "anxiety": ["急", "着急", "救命", "慌", "挠头"],
            "grievance": ["无语", "吐槽", "绷不住", "离谱"],
        }
        for emotion, markers in keyword_map.items():
            if any(marker in lowered for marker in markers):
                emotions.append(emotion)
        if any(c in text for c in "✧☆♪❤♡"):
            emotions.append("joy")
        if any(c in text for c in "╥;´`"):
            emotions.append("sadness")
        if any(c in text for c in "╬◣◢皿"):
            emotions.append("anger")
        return _safe_string_list(emotions) or (["joy"] if fallback else [])

    def _infer_style_tags(self, text: str) -> list[str]:
        """Infer broad local preference tags from captions and filenames."""
        lowered = text.lower()
        tag_markers = {
            "猫咪": ["猫", "cat", "neko"],
            "动漫": ["动漫", "动画", "二次元", "anime"],
            "游戏": ["游戏", "game", "明日方舟", "蔚蓝档案"],
            "热门梗": ["梗", "meme", "表情包"],
            "可爱": ["可爱", "萌", "cute"],
        }
        return [tag for tag, markers in tag_markers.items() if any(marker in lowered for marker in markers)]

    def _infer_image_emotions(self, image_data_url: str) -> list[str]:
        """Infer coarse emotion tags from image color/brightness, fully locally."""
        try:
            payload = image_data_url.split(",", 1)[1]
            raw = base64.b64decode(payload, validate=True)
            from PIL import Image, ImageStat

            with Image.open(io.BytesIO(raw)) as image:
                width, height = image.size
                if width <= 0 or height <= 0 or width * height > 25_000_000:
                    return []
                frame = image.convert("RGB")
                frame.thumbnail((64, 64))
                stat = ImageStat.Stat(frame)
                red, green, blue = (float(value) for value in stat.mean[:3])
                contrast = sum(float(value) for value in stat.stddev[:3]) / 3.0
                pixels = list(frame.getdata())
            brightness = (red + green + blue) / (3.0 * 255.0)
            saturation = sum(
                colorsys.rgb_to_hsv(r / 255.0, g / 255.0, b / 255.0)[1]
                for r, g, b in pixels
            ) / max(1, len(pixels))
            tags: list[str] = []
            if red > green * 1.18 and red > blue * 1.18 and saturation > 0.35:
                tags.extend(["anger", "excitement"])
            elif brightness > 0.70 and saturation > 0.25:
                tags.extend(["joy", "excitement"])
            elif brightness < 0.32:
                tags.extend(["sadness", "calm"])
            elif saturation < 0.16 or contrast < 24:
                tags.extend(["calm", "touched"])
            else:
                tags.extend(["joy", "calm"])
            return _safe_string_list(tags)
        except Exception:
            logger.debug("Sticker image emotion inference failed", exc_info=True)
            return []

    @property
    def count(self) -> int:
        return len(self._stickers)


def _atomic_write_json(filepath: Path, data: object) -> None:
    temp_path = filepath.with_suffix(filepath.suffix + ".tmp")
    temp_path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    temp_path.replace(filepath)

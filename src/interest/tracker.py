"""InterestTracker — tracks the character's evolving interests over time.

The character develops interests based on:
  - Conversations with the user (topics discussed)
  - Web surfing discoveries
  - Memories and experiences

Interests grow, plateau, and sometimes fade, creating a natural evolution.
Design: #90-93 from the feature spec.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field, asdict
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

from ..config.settings import INTEREST_DIR
from ..local_store import atomic_write_json, read_json_object

if TYPE_CHECKING:
    from ..persona.state_scope import PersonaModuleState

logger = logging.getLogger("reverie.interest")


@dataclass
class Interest:
    """A single interest the character has developed."""
    name: str                      # e.g. "baking", "quantum computing", "gardening"
    category: str = "hobby"        # hobby | academic | media | social | creative
    level: float = 10.0            # 0-100 interest intensity
    growth_rate: float = 1.0       # how fast it grows per interaction
    progress: float = 0.0          # monotonic practice/project progress
    discovered_at: str = ""        # ISO date
    last_active: str = ""          # ISO date of last engagement
    milestones: list[str] = field(default_factory=list)  # achievements/discoveries
    activity_history: list[dict[str, Any]] = field(default_factory=list)
    outputs: list[dict[str, Any]] = field(default_factory=list)
    source: str = "conversation"   # conversation | web | self_initiated

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "Interest":
        return cls(
            name=data.get("name", ""),
            category=data.get("category", "hobby"),
            level=data.get("level", 10.0),
            growth_rate=data.get("growth_rate", 1.0),
            progress=max(0.0, min(100.0, float(data.get("progress", 0.0) or 0.0))),
            discovered_at=data.get("discovered_at", ""),
            last_active=data.get("last_active", ""),
            milestones=[
                str(item) for item in data.get("milestones", []) if str(item).strip()
            ] if isinstance(data.get("milestones", []), list) else [],
            activity_history=[
                item for item in data.get("activity_history", []) if isinstance(item, dict)
            ] if isinstance(data.get("activity_history", []), list) else [],
            outputs=[
                item for item in data.get("outputs", []) if isinstance(item, dict)
            ] if isinstance(data.get("outputs", []), list) else [],
            source=data.get("source", "conversation"),
        )


class InterestTracker:
    """Manages the character's evolving interests."""

    def __init__(
        self,
        data_dir: Path | None = None,
        *,
        state_scope: "PersonaModuleState | None" = None,
        world_clock=None,
    ) -> None:
        if state_scope is not None and data_dir is not None:
            if Path(data_dir).resolve() != state_scope.path.resolve():
                raise ValueError("InterestTracker data_dir conflicts with persona state scope")
        self._state_scope = state_scope
        self.world_clock = world_clock
        self.data_dir = state_scope.path if state_scope is not None else (data_dir or INTEREST_DIR)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.path = self.data_dir / "tracker.json"
        self._interests: dict[str, Interest] = {}
        self._load()

    def _now_local(self) -> datetime:
        """Naive wall time in the world clock zone, or process-local fallback."""
        if self.world_clock is not None:
            return self.world_clock.now().replace(tzinfo=None)
        return datetime.now()

    def ensure_defaults(self, persona: Any, *, now: datetime | None = None) -> int:
        """Seed stable persona hobbies once; existing local state always wins."""
        self._require_scope()
        now = now or self._now_local()
        inserted = 0
        for raw_name in getattr(persona, "daily_life", {}).get("hobbies", []):
            name = str(raw_name).strip()
            if not name or name.lower() in self._interests:
                continue
            self._interests[name.lower()] = Interest(
                name=name,
                category="creative" if any(mark in name for mark in ("画", "写", "创作", "摄影")) else "hobby",
                level=35.0,
                progress=10.0,
                discovered_at=now.isoformat(),
                source="persona",
                activity_history=[{"at": now.isoformat(), "note": "作为长期兴趣建立", "progress": 10.0}],
            )
            inserted += 1
        if inserted:
            self._save()
        return inserted

    def record_engagement(self, name: str, source: str = "conversation", boost: float = 2.0) -> None:
        """Record that the character engaged with an interest."""
        self.record_activity(
            name,
            note="在聊天或生活里又接触了一次",
            progress_boost=max(0.0, boost),
            source=source,
        )

    def record_activity(
        self,
        name: str,
        *,
        note: str,
        progress_boost: float = 2.0,
        source: str = "self_initiated",
        now: datetime | None = None,
        output: dict[str, Any] | None = None,
    ) -> Interest:
        """Record one real activity and advance progress without regression."""
        self._require_scope()
        clean_name = name.strip()[:120]
        if not clean_name:
            raise ValueError("兴趣名称不能为空")
        now = now or self._now_local()
        key = clean_name.lower()
        interest = self._interests.get(key)
        if interest is None:
            interest = Interest(name=clean_name, discovered_at=now.isoformat(), source=source, level=12.0)
            self._interests[key] = interest
        old_progress = interest.progress
        boost = max(0.0, float(progress_boost))
        interest.level = min(100.0, interest.level + boost * interest.growth_rate)
        interest.progress = min(100.0, max(old_progress, old_progress + boost))
        interest.last_active = now.isoformat()
        interest.activity_history.append({
            "at": now.isoformat(),
            "note": note.strip()[:300] or "继续投入了一点时间",
            "progress": interest.progress,
            "source": source[:40],
        })
        self._record_crossed_milestones(interest, old_progress, now)
        if output:
            self._append_output(interest, output, now)
        self._save()
        return interest

    def advance_due(self, now: datetime | None = None) -> Interest | None:
        """Advance one established hobby at most once per local day."""
        self._require_scope()
        now = now or self._now_local()
        for interest in self.get_top_interests(self.count):
            if interest.progress >= 100.0:
                continue
            try:
                last = datetime.fromisoformat(interest.last_active) if interest.last_active else None
            except ValueError:
                # A corrupt timestamp must not cause the same interest to be
                # advanced every day until it maxes out. Conservatively skip it
                # and let record_activity refresh the timestamp on real use.
                logger.warning("Interest %r has an unparsable last_active; skipping auto-advance", interest.name)
                continue
            if last is not None and last.date() >= now.date():
                continue
            return self.record_activity(
                interest.name,
                note="自己抽时间继续练习了一会儿",
                progress_boost=4.0,
                source="self_initiated",
                now=now,
            )
        return None

    def decay_interests(self, days_passed: int = 1, decay_rate: float = 0.5) -> None:
        """Let intensity cool without deleting established interests or progress."""
        self._require_scope()
        for interest in self._interests.values():
            interest.level = max(1.0, interest.level - max(0.0, decay_rate * days_passed))
        if self._interests:
            self._save()

    def add_milestone(self, name: str, milestone: str) -> None:
        """Add a milestone to an interest."""
        self._require_scope()
        name_key = name.lower()
        if name_key in self._interests:
            clean = milestone.strip()[:240]
            if clean and clean not in self._interests[name_key].milestones:
                self._interests[name_key].milestones.append(clean)
                self._save()

    def record_output(
        self,
        name: str,
        *,
        title: str,
        kind: str = "creative",
        media_url: str = "",
        note: str = "",
        now: datetime | None = None,
    ) -> dict[str, Any] | None:
        self._require_scope()
        interest = self._interests.get(name.lower())
        if interest is None:
            return None
        saved = self._append_output(
            interest,
            {"title": title, "kind": kind, "media_url": media_url, "note": note},
            now or self._now_local(),
        )
        self._save()
        return saved

    def get_reusable_output(self) -> dict[str, Any] | None:
        self._require_scope()
        candidates: list[tuple[str, dict[str, Any]]] = []
        for interest in self._interests.values():
            for output in interest.outputs:
                candidates.append((interest.name, output))
        if not candidates:
            return None
        name, output = max(candidates, key=lambda item: str(item[1].get("created_at", "")))
        return {**output, "interest": name}

    def get_top_interests(self, n: int = 5) -> list[Interest]:
        """Get the character's strongest current interests."""
        self._require_scope()
        sorted_interests = sorted(self._interests.values(), key=lambda i: i.level, reverse=True)
        return sorted_interests[:n]

    def build_interest_context(self) -> str:
        """Build a context string for LLM prompt injection."""
        self._require_scope()
        top = self.get_top_interests(4)
        if not top:
            return ""
        
        lines = []
        for interest in top:
            latest = interest.activity_history[-1].get("note", "") if interest.activity_history else ""
            output = interest.outputs[-1].get("title", "") if interest.outputs else ""
            line = f"- {interest.name}：长期兴趣，进度 {interest.progress:.0f}%"
            if latest:
                line += f"，最近{latest}"
            if output:
                line += f"，已有成果“{output}”，之后可以再次提到"
            lines.append(line)
            
        return "\n".join(lines)

    @property
    def count(self) -> int:
        self._require_scope()
        return len(self._interests)

    def export_all(self) -> dict[str, Any]:
        self._require_scope()
        return self._serialize()

    def _serialize(self) -> dict[str, Any]:
        return {
            "schema": "reverie.interests.v2",
            "interests": [item.to_dict() for item in self._interests.values()],
        }

    def import_all(self, payload: dict[str, Any]) -> int:
        self._require_scope()
        rows = payload.get("interests", []) if isinstance(payload, dict) else []
        if not isinstance(rows, list):
            raise ValueError("兴趣备份格式无效")
        restored: dict[str, Interest] = {}
        for row in rows:
            if isinstance(row, dict):
                interest = Interest.from_dict(row)
                if interest.name:
                    restored[interest.name.lower()] = interest
        self._interests = restored
        self._save()
        return len(restored)

    def _record_crossed_milestones(self, interest: Interest, old_progress: float, now: datetime) -> None:
        for threshold in (25, 50, 75, 100):
            label = f"完成 {threshold}% 阶段"
            if old_progress < threshold <= interest.progress and label not in interest.milestones:
                interest.milestones.append(label)
                self._append_output(
                    interest,
                    {
                        "title": f"{interest.name}的阶段成果（{threshold}%）",
                        "kind": "creative" if interest.category in {"creative", "hobby"} else "progress",
                        "note": label,
                    },
                    now,
                )

    def _append_output(
        self,
        interest: Interest,
        output: dict[str, Any],
        now: datetime,
    ) -> dict[str, Any]:
        saved = {
            "id": str(output.get("id", "")).strip()[:160]
            or f"out_{interest.name}_{len(interest.outputs) + 1}",
            "title": str(output.get("title", "")).strip()[:160]
            or f"{interest.name}的阶段成果",
            "kind": str(output.get("kind", "creative"))[:40],
            "media_url": str(output.get("media_url", ""))[:2_000_000],
            "note": str(output.get("note", ""))[:300],
            "created_at": str(output.get("created_at", ""))[:40] or now.isoformat(),
        }
        if not any(item.get("id") == saved["id"] for item in interest.outputs):
            interest.outputs.append(saved)
        return saved

    # ── Persistence ────────────────────────────────────────

    def _save(self) -> None:
        payload = self._serialize()
        if self._state_scope is None:
            atomic_write_json(self.path, payload)
            return
        self._state_scope.commit_bound(lambda: atomic_write_json(self.path, payload))

    def _load(self) -> None:
        self._require_scope()
        try:
            data = read_json_object(self.path)
            if not data:
                return
            for i_data in data.get("interests", []):
                if isinstance(i_data, dict):
                    interest = Interest.from_dict(i_data)
                    if interest.name:
                        self._interests[interest.name.lower()] = interest
        except Exception:
            logger.exception("InterestTracker: failed to load")
            self._interests = {}

    def _require_scope(self) -> None:
        if self._state_scope is not None:
            self._state_scope.require_current()

"""Local-first personal affairs with monotonic, time-based progress."""

from __future__ import annotations

import hashlib
import logging
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Any

from ..config.settings import AFFAIRS_DIR
from ..local_store import atomic_write_json, read_json_object
from ..persona.identity import StalePersonaEpoch

if TYPE_CHECKING:
    from ..interest.tracker import InterestTracker
    from ..persona.persona_card import Persona
    from ..persona.state_scope import PersonaModuleState

logger = logging.getLogger("reverie.affairs")


@dataclass
class PersonalAffair:
    id: str
    title: str
    details: str = ""
    category: str = "personal"
    status: str = "planned"
    progress: float = 0.0
    created_at: str = ""
    updated_at: str = ""
    next_update_at: str = ""
    due_at: str = ""
    related_interest: str = ""
    history: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PersonalAffair":
        status = str(data.get("status", "planned"))
        if status not in {"planned", "in_progress", "paused", "completed"}:
            status = "planned"
        history = data.get("history", [])
        return cls(
            id=str(data.get("id", ""))[:160],
            title=str(data.get("title", ""))[:160],
            details=str(data.get("details", ""))[:1000],
            category=str(data.get("category", "personal"))[:40],
            status=status,
            progress=max(0.0, min(100.0, float(data.get("progress", 0.0) or 0.0))),
            created_at=str(data.get("created_at", ""))[:40],
            updated_at=str(data.get("updated_at", ""))[:40],
            next_update_at=str(data.get("next_update_at", ""))[:40],
            due_at=str(data.get("due_at", ""))[:40],
            related_interest=str(data.get("related_interest", ""))[:120],
            history=[item for item in history if isinstance(item, dict)]
            if isinstance(history, list) else [],
        )


class PersonalAffairManager:
    """Owns plans that belong to the character, not to the user."""

    def __init__(
        self,
        data_dir: Path | None = None,
        *,
        interest_tracker: "InterestTracker | None" = None,
        state_scope: "PersonaModuleState | None" = None,
        world_clock=None,
    ) -> None:
        if state_scope is not None and data_dir is not None:
            if Path(data_dir).resolve() != state_scope.path.resolve():
                raise ValueError("PersonalAffairManager data_dir conflicts with persona state scope")
        self._state_scope = state_scope
        self.world_clock = world_clock
        self.data_dir = state_scope.path if state_scope is not None else (data_dir or AFFAIRS_DIR)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.path = self.data_dir / "affairs.json"
        self.interest_tracker = interest_tracker
        self._affairs: dict[str, PersonalAffair] = {}
        self._load()

    def _now_local(self) -> datetime:
        """Naive wall time in the world clock zone, or process-local fallback."""
        if self.world_clock is not None:
            return self.world_clock.now().replace(tzinfo=None)
        return datetime.now()

    def ensure_defaults(self, persona: "Persona", *, now: datetime | None = None) -> int:
        self._require_scope()
        if self._affairs:
            return 0
        now = now or self._now_local()
        identity = str(persona.identity.get("title", "自己的工作") or "自己的工作")
        hobbies = [str(item).strip() for item in persona.daily_life.get("hobbies", []) if str(item).strip()]
        hobby = next((item for item in hobbies if item != "写日记"), hobbies[0] if hobbies else "阅读")
        self.create(
            "整理近期的工作思路",
            details=f"围绕{identity}整理一份只属于自己的阶段计划",
            category="work",
            now=now,
        )
        self.create(
            f"继续培养{hobby}",
            details=f"稳定投入时间练习{hobby}，留下可以回看的进度",
            category="hobby",
            related_interest=hobby,
            now=now,
        )
        return 2

    def create(
        self,
        title: str,
        *,
        details: str = "",
        category: str = "personal",
        due_at: str = "",
        related_interest: str = "",
        now: datetime | None = None,
    ) -> PersonalAffair:
        self._require_scope()
        clean_title = title.strip()[:160]
        if not clean_title:
            raise ValueError("事务标题不能为空")
        now = now or self._now_local()
        affair_id = "aff_" + hashlib.sha256(
            f"{clean_title}\0{now.isoformat()}".encode("utf-8")
        ).hexdigest()[:14]
        affair = PersonalAffair(
            id=affair_id,
            title=clean_title,
            details=details.strip()[:1000],
            category=category.strip()[:40] or "personal",
            created_at=now.isoformat(),
            updated_at=now.isoformat(),
            next_update_at=(now + timedelta(hours=6)).isoformat(),
            due_at=due_at[:40],
            related_interest=related_interest.strip()[:120],
            history=[{"at": now.isoformat(), "progress": 0.0, "note": "建立计划"}],
        )
        self._affairs[affair.id] = affair
        self._save()
        return affair

    def record_progress(
        self,
        affair_id: str,
        progress: float,
        note: str,
        *,
        now: datetime | None = None,
    ) -> PersonalAffair:
        self._require_scope()
        affair = self._affairs[affair_id]
        new_progress = max(affair.progress, min(100.0, float(progress)))
        now = now or self._now_local()
        affair.progress = new_progress
        affair.status = "completed" if new_progress >= 100.0 else "in_progress"
        affair.updated_at = now.isoformat()
        affair.next_update_at = "" if affair.status == "completed" else (now + timedelta(hours=8)).isoformat()
        affair.history.append({
            "at": now.isoformat(),
            "progress": new_progress,
            "note": note.strip()[:300] or "推进了一点",
        })
        self._save()
        return affair

    def advance_due(self, now: datetime | None = None) -> list[dict[str, Any]]:
        self._require_scope()
        now = now or self._now_local()
        updates: list[dict[str, Any]] = []
        changed = False
        for affair in self._affairs.values():
            if affair.status in {"paused", "completed"}:
                continue
            due = _parse_datetime(affair.next_update_at)
            if due is None and affair.next_update_at:
                # Corrupt timestamp: treat as not-yet-due and refresh the
                # field so the affair does not stall forever.
                affair.next_update_at = (now + timedelta(hours=8)).isoformat()
                changed = True
                continue
            if due is None:
                # Empty scheduling field from old data: self-heal with a
                # default window instead of advancing on every 15-minute tick.
                affair.next_update_at = (now + timedelta(hours=8)).isoformat()
                changed = True
                continue
            if _coerce_like(now, due) < due:
                continue
            step = 8.0 + (int(hashlib.sha256(f"{affair.id}:{now.date()}".encode()).hexdigest()[:2], 16) % 7)
            old_progress = affair.progress
            new_progress = min(100.0, old_progress + step)
            note = "完成了一个阶段" if new_progress < 100 else "这件事告一段落"
            affair.progress = new_progress
            affair.status = "completed" if new_progress >= 100.0 else "in_progress"
            affair.updated_at = now.isoformat()
            affair.next_update_at = "" if affair.status == "completed" else (now + timedelta(hours=8)).isoformat()
            affair.history.append({"at": now.isoformat(), "progress": new_progress, "note": note})
            updates.append({
                "affair_id": affair.id,
                "title": affair.title,
                "old_progress": old_progress,
                "progress": new_progress,
                "status": affair.status,
                "note": note,
            })
            changed = True
            if affair.related_interest and self.interest_tracker is not None:
                try:
                    self.interest_tracker.record_activity(
                        affair.related_interest,
                        note=f"因为“{affair.title}”{note}",
                        progress_boost=max(1.0, step / 2),
                        source="self_initiated",
                        now=now,
                    )
                except StalePersonaEpoch:
                    raise
                except Exception:
                    logger.exception("Affair progress could not update related interest")
        if changed:
            self._save()
        return updates

    def get_active(self, limit: int = 5) -> list[PersonalAffair]:
        self._require_scope()
        active = [item for item in self._affairs.values() if item.status != "completed"]
        return sorted(active, key=lambda item: item.updated_at, reverse=True)[: max(0, limit)]

    def build_prompt_context(self) -> str:
        self._require_scope()
        lines: list[str] = []
        for affair in self.get_active(4):
            latest = affair.history[-1].get("note", "") if affair.history else ""
            lines.append(
                f"- {affair.title}：{affair.status}，进度 {affair.progress:.0f}%"
                + (f"，最近{latest}" if latest else "")
            )
        completed = sorted(
            (item for item in self._affairs.values() if item.status == "completed"),
            key=lambda item: item.updated_at,
            reverse=True,
        )[:2]
        for affair in completed:
            lines.append(f"- {affair.title}：已完成，不能再说成尚未开始")
        return "\n".join(lines)

    def latest_update(self) -> dict[str, Any] | None:
        self._require_scope()
        affairs = [item for item in self._affairs.values() if item.history]
        if not affairs:
            return None
        affair = max(affairs, key=lambda item: item.updated_at)
        return {
            "id": affair.id,
            "title": affair.title,
            "status": affair.status,
            "progress": affair.progress,
            "note": affair.history[-1].get("note", ""),
            "updated_at": affair.updated_at,
        }

    def export_all(self) -> dict[str, Any]:
        self._require_scope()
        return self._serialize()

    def _serialize(self) -> dict[str, Any]:
        return {
            "schema": "reverie.affairs.v1",
            "affairs": [item.to_dict() for item in self._affairs.values()],
        }

    def import_all(self, payload: dict[str, Any]) -> int:
        self._require_scope()
        rows = payload.get("affairs", []) if isinstance(payload, dict) else []
        if not isinstance(rows, list):
            raise ValueError("事务备份格式无效")
        restored: dict[str, PersonalAffair] = {}
        for row in rows:
            if isinstance(row, dict):
                affair = PersonalAffair.from_dict(row)
                if affair.id and affair.title:
                    restored[affair.id] = affair
        self._affairs = restored
        self._save()
        return len(restored)

    @property
    def count(self) -> int:
        self._require_scope()
        return len(self._affairs)

    def _save(self) -> None:
        payload = self._serialize()
        if self._state_scope is None:
            atomic_write_json(self.path, payload)
            return
        self._state_scope.commit_bound(lambda: atomic_write_json(self.path, payload))

    def _load(self) -> None:
        self._require_scope()
        try:
            payload = read_json_object(self.path)
            if payload:
                rows = payload.get("affairs", [])
                if isinstance(rows, list):
                    for row in rows:
                        if isinstance(row, dict):
                            affair = PersonalAffair.from_dict(row)
                            if affair.id and affair.title:
                                self._affairs[affair.id] = affair
        except Exception:
            logger.exception("Failed to load personal affairs")
            self._affairs = {}

    def _require_scope(self) -> None:
        if self._state_scope is not None:
            self._state_scope.require_current()


def _parse_datetime(value: str) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _coerce_like(value: datetime, reference: datetime) -> datetime:
    if reference.tzinfo is None:
        return value.replace(tzinfo=None)
    if value.tzinfo is None:
        return value.replace(tzinfo=reference.tzinfo)
    return value.astimezone(reference.tzinfo)

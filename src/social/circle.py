"""SocialCircle — the character's fixed social network.

Defines friends, family, and acquaintances that the character refers to
in conversation, diary entries, and timeline posts. These NPCs give the
character a believable social life independent of the user.

Design: #82-85 from the feature spec.
"""

from __future__ import annotations

import hashlib
import logging
import random
from dataclasses import dataclass, field, asdict
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

from ..config.settings import SOCIAL_DIR
from ..local_store import atomic_write_json, read_json_object

if TYPE_CHECKING:
    from ..persona.state_scope import PersonaModuleState

logger = logging.getLogger("reverie.social")


@dataclass
class SocialContact:
    """A single person in the character's social circle."""
    name: str
    relationship: str          # e.g. "childhood friend", "colleague", "sister"
    id: str = ""
    category: str = "friend"   # friend | family | colleague | acquaintance
    personality_brief: str = ""  # 1-2 sentence personality sketch
    shared_memories: list[str] = field(default_factory=list)  # key shared experiences
    current_status: str = "normal"  # normal | busy | traveling | sick | celebrating
    last_mentioned: str = ""    # ISO date of last reference in chat/diary/timeline
    closeness: int = 50         # 0-100 how close the character feels to them

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "SocialContact":
        return cls(
            name=data.get("name", ""),
            relationship=data.get("relationship", ""),
            id=str(data.get("id", ""))[:160],
            category=data.get("category", "friend"),
            personality_brief=data.get("personality_brief", ""),
            shared_memories=data.get("shared_memories", []),
            current_status=data.get("current_status", "normal"),
            last_mentioned=data.get("last_mentioned", ""),
            closeness=data.get("closeness", 50),
        )


@dataclass
class SocialEvent:
    id: str
    contact_id: str
    contact_name: str
    event_type: str
    description: str
    occurred_at: str
    emotion_changes: dict[str, float] = field(default_factory=dict)
    behavior_hint: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SocialEvent":
        changes = data.get("emotion_changes", {})
        return cls(
            id=str(data.get("id", ""))[:160],
            contact_id=str(data.get("contact_id", ""))[:160],
            contact_name=str(data.get("contact_name", ""))[:120],
            event_type=str(data.get("event_type", "chat"))[:40],
            description=str(data.get("description", ""))[:500],
            occurred_at=str(data.get("occurred_at", ""))[:40],
            emotion_changes={str(k): float(v) for k, v in changes.items()}
            if isinstance(changes, dict) else {},
            behavior_hint=str(data.get("behavior_hint", ""))[:300],
        )


class SocialCircle:
    """Manages the character's social network.

    Usage::
        circle = SocialCircle()
        circle.add_contact(SocialContact(name="Yuki", relationship="best friend", ...))
        friend = circle.get_random_contact()
        context = circle.build_social_context()
    """

    def __init__(
        self,
        data_dir: Path | None = None,
        *,
        state_scope: "PersonaModuleState | None" = None,
    ) -> None:
        if state_scope is not None and data_dir is not None:
            if Path(data_dir).resolve() != state_scope.path.resolve():
                raise ValueError("SocialCircle data_dir conflicts with persona state scope")
        self._state_scope = state_scope
        self.data_dir = state_scope.path if state_scope is not None else (data_dir or SOCIAL_DIR)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.path = self.data_dir / "circle.json"
        self._contacts: list[SocialContact] = []
        self._events: list[SocialEvent] = []
        self._load()

    def ensure_defaults(self, persona: Any, *, now: datetime | None = None) -> int:
        """Create a small fixed circle only when no local relationships exist."""
        self._require_scope()
        if self._contacts:
            return 0
        organization = str(getattr(persona, "identity", {}).get("organization", "工作室") or "工作室")
        owner = str(getattr(persona, "name", "她") or "她")
        self.add_contact(SocialContact(
            id="fixed_friend_lincheng",
            name="林澄",
            relationship="认识多年的朋友",
            category="friend",
            personality_brief="说话直接，但遇到重要的事很可靠",
            shared_memories=[f"林澄和{owner}认识很多年，彼此知道一些生活习惯。"],
            closeness=76,
        ))
        self.add_contact(SocialContact(
            id="fixed_colleague_chengxia",
            name="程夏",
            relationship=f"{organization}的长期同事",
            category="colleague",
            personality_brief="做事细致，偶尔会提醒她别忙过头",
            shared_memories=[f"程夏长期和{owner}在{organization}共事。"],
            closeness=64,
        ))
        return 2

    def add_contact(self, contact: SocialContact) -> None:
        """Add a new contact to the social circle."""
        self._require_scope()
        if not contact.id:
            contact.id = _contact_id(contact.name)
        self._contacts.append(contact)
        self._save()

    def upsert_contact(self, contact: SocialContact) -> None:
        """Create or update a contact by name."""
        self._require_scope()
        if not contact.id:
            contact.id = _contact_id(contact.name)
        for index, existing in enumerate(self._contacts):
            if existing.name.lower() == contact.name.lower():
                contact.id = existing.id or contact.id
                self._contacts[index] = contact
                self._save()
                return
        self._contacts.append(contact)
        self._save()

    def remove_contact(self, name: str) -> bool:
        """Remove a contact by name. Returns True if found and removed."""
        self._require_scope()
        before = len(self._contacts)
        self._contacts = [c for c in self._contacts if c.name != name]
        if len(self._contacts) < before:
            self._save()
            return True
        return False

    def get_contact(self, name: str) -> SocialContact | None:
        """Find a contact by name (case-insensitive)."""
        self._require_scope()
        for c in self._contacts:
            if c.name.lower() == name.lower():
                return c
        return None

    def get_contacts_by_category(self, category: str) -> list[SocialContact]:
        """Get all contacts in a given category."""
        self._require_scope()
        return [c for c in self._contacts if c.category == category]

    def get_random_contact(self, category: str | None = None) -> SocialContact | None:
        """Pick a random contact, optionally from a specific category."""
        self._require_scope()
        pool = self.get_contacts_by_category(category) if category else self._contacts
        return random.choice(pool) if pool else None

    def get_close_contacts(self, min_closeness: int = 70) -> list[SocialContact]:
        """Get contacts above a closeness threshold."""
        self._require_scope()
        return [c for c in self._contacts if c.closeness >= min_closeness]

    def update_status(self, name: str, status: str) -> None:
        """Update a contact's current status."""
        self._require_scope()
        contact = self.get_contact(name)
        if contact:
            contact.current_status = status
            self._save()

    def mark_mentioned(self, name: str, date_str: str) -> None:
        """Record that a contact was mentioned on a given date."""
        self._require_scope()
        contact = self.get_contact(name)
        if contact:
            contact.last_mentioned = date_str
            self._save()

    def build_social_context(self, max_contacts: int = 5) -> str:
        """Build a context string for LLM prompt injection.
        
        Returns a summary of the character's social circle for the system prompt.
        """
        self._require_scope()
        if not self._contacts:
            return ""
        
        # Deterministic ordering prevents the world roster changing between prompts.
        close = sorted(self._contacts, key=lambda c: (-c.closeness, c.name))[:max_contacts]
        
        lines = []
        for c in close:
            status_note = f"，目前状态：{c.current_status}" if c.current_status != "normal" else ""
            recent = next((event for event in reversed(self._events) if event.contact_id == c.id), None)
            recent_note = f"；最近事件：{recent.description}" if recent else ""
            lines.append(f"- {c.name}：{c.relationship}{status_note}。{c.personality_brief}{recent_note}")
        
        return "\n".join(lines)

    def sync_character_cards(self, cards: list[dict[str, Any]], *, owner_name: str = "") -> int:
        """Link imported/active character cards into this character's world."""
        self._require_scope()
        inserted_or_updated = 0
        for card in cards:
            name = str(card.get("name", "")).strip()
            if not name or (owner_name and name == owner_name):
                continue
            identity = str(card.get("identity", "") or card.get("role", "")).strip()
            personality = str(card.get("personality", "") or card.get("description", "")).strip()
            self.upsert_contact(
                SocialContact(
                    name=name,
                    relationship="由角色卡关联的同伴",
                    category="acquaintance",
                    personality_brief=(personality or identity)[:220],
                    shared_memories=[
                        f"{owner_name or '她'}通过角色卡认识了{name}。",
                        identity[:180],
                    ],
                    current_status="normal",
                    closeness=55,
                )
            )
            inserted_or_updated += 1
        return inserted_or_updated

    def generate_social_event(self, *, now: datetime | None = None) -> dict[str, Any] | None:
        """Generate a random social event for timeline/diary content.
        
        Returns a dict with 'contact_name', 'event_type', 'description' or None.
        """
        self._require_scope()
        if not self._contacts:
            return None
        
        contact = random.choice(self._contacts)
        events_by_category = {
            "friend": [
                ("hangout", f"和{contact.name}一起出去走了走", {"joy": 5.0, "calm": 2.0}, "心情会轻松一点"),
                ("chat", f"和{contact.name}认真聊了很久", {"calm": 4.0, "touched": 2.0}, "之后可能会想起这次谈话"),
                ("gift", f"{contact.name}送来了一件可爱的小东西", {"joy": 6.0, "touched": 5.0}, "会珍惜这份心意"),
                ("plan", f"和{contact.name}约好了周末再见", {"excitement": 4.0}, "会期待周末的安排"),
            ],
            "family": [
                ("call", f"今天和{contact.name}通了电话", {"calm": 3.0}, "会留意对方近况"),
                ("visit", f"{contact.name}说过几天会来看看", {"excitement": 3.0}, "会为见面做准备"),
                ("concern", f"最近有点担心{contact.name}", {"anxiety": 5.0, "sadness": 2.0}, "主动行为会更关切"),
            ],
            "colleague": [
                ("project", f"和{contact.name}一起推进了手头的工作", {"calm": 2.0, "excitement": 2.0}, "会继续关注工作进展"),
                ("lunch", f"中午和{contact.name}一起吃了饭", {"joy": 2.0}, "下午状态会放松些"),
                ("help", f"{contact.name}帮忙解决了一个棘手问题", {"touched": 4.0, "anxiety": -3.0}, "之后可能会表达感谢"),
            ],
            "acquaintance": [
                ("encounter", f"意外碰见了{contact.name}", {"excitement": 2.0}, "会短暂提起这次偶遇"),
                ("message", f"收到了{contact.name}发来的消息", {"calm": 1.0}, "可能会抽空回复"),
            ],
        }
        
        pool = events_by_category.get(contact.category, events_by_category["friend"])
        event_type, description, emotion_changes, behavior_hint = random.choice(pool)
        event = self.record_event(
            contact.name,
            event_type=event_type,
            description=description,
            emotion_changes=emotion_changes,
            behavior_hint=behavior_hint,
            now=now,
        )
        return event.to_dict()

    def record_event(
        self,
        contact_name: str,
        *,
        event_type: str,
        description: str,
        emotion_changes: dict[str, float] | None = None,
        behavior_hint: str = "",
        now: datetime | None = None,
    ) -> SocialEvent:
        self._require_scope()
        contact = self.get_contact(contact_name)
        if contact is None:
            raise KeyError(f"未知社交联系人：{contact_name}")
        now = now or datetime.now()
        event = SocialEvent(
            id="soc_" + hashlib.sha256(
                f"{contact.id}\0{event_type}\0{now.isoformat()}".encode("utf-8")
            ).hexdigest()[:14],
            contact_id=contact.id,
            contact_name=contact.name,
            event_type=event_type[:40],
            description=description.strip()[:500],
            occurred_at=now.isoformat(),
            emotion_changes={str(k): float(v) for k, v in (emotion_changes or {}).items()},
            behavior_hint=behavior_hint.strip()[:300],
        )
        self._events.append(event)
        contact.last_mentioned = now.date().isoformat()
        self._save()
        return event

    def list_history(self, contact_name: str | None = None, limit: int = 50) -> list[SocialEvent]:
        self._require_scope()
        rows = self._events
        if contact_name:
            rows = [event for event in rows if event.contact_name.lower() == contact_name.lower()]
        return rows[-max(0, limit):]

    @property
    def count(self) -> int:
        self._require_scope()
        return len(self._contacts)

    def export_all(self) -> dict[str, Any]:
        self._require_scope()
        return self._serialize()

    def _serialize(self) -> dict[str, Any]:
        return {
            "schema": "reverie.social_circle.v2",
            "contacts": [contact.to_dict() for contact in self._contacts],
            "events": [event.to_dict() for event in self._events],
        }

    def import_all(self, payload: dict[str, Any]) -> int:
        self._require_scope()
        contacts = payload.get("contacts", []) if isinstance(payload, dict) else []
        events = payload.get("events", []) if isinstance(payload, dict) else []
        if not isinstance(contacts, list) or not isinstance(events, list):
            raise ValueError("社交圈备份格式无效")
        self._contacts = [SocialContact.from_dict(item) for item in contacts if isinstance(item, dict)]
        for contact in self._contacts:
            if not contact.id:
                contact.id = _contact_id(contact.name)
        known_ids = {contact.id for contact in self._contacts}
        self._events = [
            SocialEvent.from_dict(item)
            for item in events
            if isinstance(item, dict) and str(item.get("contact_id", "")) in known_ids
        ]
        self._save()
        return len(self._contacts)

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
            self._contacts = [SocialContact.from_dict(c) for c in data.get("contacts", [])]
            for contact in self._contacts:
                if not contact.id:
                    contact.id = _contact_id(contact.name)
            self._events = [
                SocialEvent.from_dict(item)
                for item in data.get("events", [])
                if isinstance(item, dict)
            ]
        except Exception:
            logger.exception("SocialCircle: failed to load")
            self._contacts = []
            self._events = []

    def _require_scope(self) -> None:
        if self._state_scope is not None:
            self._state_scope.require_current()


def _contact_id(name: str) -> str:
    return "contact_" + hashlib.sha256(name.strip().lower().encode("utf-8")).hexdigest()[:14]

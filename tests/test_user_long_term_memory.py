import asyncio

from src.api.adapter import ChatResponse
from src.chat.session import ChatSession
from src.persona.persona_card import default_persona
from src.memory.cognitive_decay import FUZZY_RECALL_PREFIX
from src.persona.prompt_builder import build_system_prompt
from src.relationship.tracker import RelationshipTracker
from src.user import UserManager


class FakeAdapter:
    def __init__(self) -> None:
        self.calls: list[list[dict]] = []

    async def chat(self, messages: list[dict], **_kwargs) -> ChatResponse:
        self.calls.append(messages)
        return ChatResponse("唔，我在这里，不会走的")


class FakeMemory:
    def __init__(self) -> None:
        self.facts: list[tuple[str, str]] = []
        self.synced = 0

    def retrieve_relevant(self, _query: str) -> list[str]:
        return []

    async def store_interaction(self, *_args, **_kwargs) -> None:
        return None

    def store_fact(self, fact: str, layer: str = "long_term") -> str:
        self.facts.append((fact, layer))
        return f"fact-{len(self.facts)}"

    def sync_user_profile(self, _user_manager: UserManager) -> int:
        self.synced += 1
        return self.synced


class FakeEmotion:
    def __init__(self) -> None:
        self.values = {
            "joy": 50.0,
            "calm": 60.0,
            "excitement": 30.0,
            "sadness": 10.0,
            "anger": 5.0,
            "anxiety": 15.0,
            "grievance": 5.0,
            "touched": 20.0,
        }

    def get_intensity(self) -> float:
        return 0.2

    async def analyze_exchange(self, *_args, **_kwargs) -> dict[str, float]:
        return {"sadness": 12.0, "touched": 6.0}

    def apply_event(self, changes: dict[str, float]) -> None:
        for key, value in changes.items():
            self.values[key] = self.values.get(key, 0.0) + value

    def tick(self) -> None:
        return None

    def get_dominant(self, n: int = 3) -> list[tuple[str, float]]:
        return sorted(self.values.items(), key=lambda item: item[1], reverse=True)[:n]


def test_default_user_profile_and_extraction_are_safe(tmp_path) -> None:
    manager = UserManager(data_dir=tmp_path)
    manager.ensure_default_profile()

    assert manager.profile.name == "星野白夜"
    assert manager.profile.favorite_games[:2] == ["明日方舟", "蔚蓝档案"]
    assert "生物学家" in manager.profile.identity

    updates = manager.extract_profile_updates("我是生物学家，今天喜欢的游戏是明日方舟、饥荒联机版")

    assert updates["identity"] == "生物学家"
    assert "name" not in updates
    assert updates["favorite_games"] == ["明日方舟", "饥荒联机版"]

    assert manager.extract_profile_updates("我的昵称是小白夜")["nickname"] == "小白夜"
    assert (
        manager.extract_profile_updates("我的身份是生物学家，医学家，化学家")["identity"]
        == "生物学家，医学家，化学家"
    )


def test_emotional_memory_is_separate_from_profile_and_prompt_context(tmp_path) -> None:
    manager = UserManager(data_dir=tmp_path)
    manager.ensure_default_profile()

    memory = manager.record_emotional_memory(
        user_message="我今天有点难过，不要离开我",
        assistant_reply="唔，我在这里",
        emotion_changes={"sadness": 12, "touched": 6},
        dominant_emotions=["calm", "touched", "sadness"],
        importance=0.8,
    )

    assert memory is not None
    assert (tmp_path / "emotional_memories.json").exists()
    assert "情感记忆分区" in manager.build_prompt_context()
    assert "我今天有点难过" in manager.build_prompt_context()


def test_emotional_memory_persistence_has_no_hidden_200_record_cap(tmp_path) -> None:
    manager = UserManager(data_dir=tmp_path)
    memories = [
        {
            "id": f"memory-{index}",
            "date": "2026-07-18",
            "summary": f"summary-{index}",
            "user_message": f"user-{index}",
            "assistant_reply": f"assistant-{index}",
            "emotion_changes": {"joy": 1.0},
            "dominant_emotions": ["joy"],
            "importance": 0.8,
            "created_at": "2026-07-18T00:00:00",
        }
        for index in range(237)
    ]

    manager.import_all({"profile": {}, "emotional_memories": memories})
    reloaded = UserManager(data_dir=tmp_path)

    assert len(reloaded.emotional_memories) == 237
    assert reloaded.emotional_memories[0].id == "memory-0"
    assert reloaded.emotional_memories[-1].id == "memory-236"


def test_prompt_builder_injects_user_context_and_emotional_behavior_rules() -> None:
    prompt = build_system_prompt(
        default_persona(),
        memories=[],
        emotions={"joy": 50, "sadness": 20},
        intimacy=300,
        user_context="用户档案分区：白夜喜欢明日方舟",
    )

    assert "USER PROFILE & EMOTIONAL MEMORIES" in prompt
    assert "白夜喜欢明日方舟" in prompt
    assert "get jealous" in prompt
    assert "never recite them like a database" in prompt


def test_prompt_builder_hides_fuzzy_recall_audit_marker_from_model() -> None:
    prompt = build_system_prompt(
        default_persona(),
        memories=[f"{FUZZY_RECALL_PREFIX}用户最近喜欢玩的游戏是异环"],
        emotions={"calm": 60},
        intimacy=500,
    )

    assert "用户最近喜欢玩的游戏是异环" in prompt
    assert FUZZY_RECALL_PREFIX not in prompt
    assert "LOW-CONFIDENCE RECOLLECTION" not in prompt


def test_chat_session_uses_user_profile_and_records_emotional_memory(tmp_path) -> None:
    user_manager = UserManager(data_dir=tmp_path)
    user_manager.ensure_default_profile()
    adapter = FakeAdapter()
    memory = FakeMemory()
    session = ChatSession(
        persona=default_persona(),
        adapter=adapter,  # type: ignore[arg-type]
        memory=memory,  # type: ignore[arg-type]
        emotion=FakeEmotion(),  # type: ignore[arg-type]
        relationship=RelationshipTracker(120),
        user_manager=user_manager,
    )

    result = asyncio.run(session.send_message("我有点难过，不要离开我"))

    assert result["reply"] == "唔，我在这里，不会走的"
    assert adapter.calls
    assert "星野白夜" in adapter.calls[0][0]["content"]
    assert user_manager.emotional_memories
    assert any(fact.startswith("情感记忆：") for fact, _layer in memory.facts)

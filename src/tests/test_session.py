from unittest.mock import AsyncMock, MagicMock

from src.chat.session import ChatSession


def test_session_init():
    persona = MagicMock()
    adapter = AsyncMock()
    memory = MagicMock()
    emotion = MagicMock()
    relationship = MagicMock()

    session = ChatSession(
        persona=persona,
        adapter=adapter,
        memory=memory,
        emotion=emotion,
        relationship=relationship,
    )

    assert session.started_at > 0
    assert session._history == []


def test_parse_memory_directive():
    persona = MagicMock()
    adapter = AsyncMock()
    memory = MagicMock()
    emotion = MagicMock()
    relationship = MagicMock()

    session = ChatSession(persona, adapter, memory, emotion, relationship)

    assert session._parse_memory_directive("Just talking") is None
    assert session._parse_memory_directive("/forget-this") == "skip"
    assert session._parse_memory_directive("/remember I like apples") == "I like apples"
    assert session._parse_memory_directive("/remember-short temporary detail") == "short_term::temporary detail"
    assert session._parse_memory_directive("/remember-long promise") == "long_term::promise"

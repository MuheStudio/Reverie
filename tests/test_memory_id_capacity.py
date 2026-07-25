from types import SimpleNamespace

from src.memory import layers as layers_module
from src.memory.layers import MemoryLayers
from src.memory import manager as manager_module
from src.memory.manager import MemoryManager


class _RecordingStore:
    def __init__(self) -> None:
        self.ids: list[str] = []

    def add(self, *, id: str, **_kwargs) -> None:
        self.ids.append(id)


def _uuid_sequence(*hex_values: str):
    values = iter(hex_values)
    return lambda: SimpleNamespace(hex=next(values))


def test_layer_ids_do_not_collapse_uuid_values_with_same_32_bit_prefix(monkeypatch) -> None:
    # This is the collision shape that the former ``hex[:8]`` implementation
    # silently converted into the same primary key.
    monkeypatch.setattr(
        layers_module.uuid,
        "uuid4",
        _uuid_sequence(
            "12345678aaaaaaaaaaaaaaaaaaaaaaaa",
            "12345678bbbbbbbbbbbbbbbbbbbbbbbb",
        ),
    )
    memory = object.__new__(MemoryLayers)
    memory.store = _RecordingStore()

    long_id = memory.store_long_term("long")
    short_id = memory.store_short_term("short")

    assert long_id == "lt_12345678aaaaaaaaaaaaaaaaaaaaaaaa"
    assert short_id == "st_12345678bbbbbbbbbbbbbbbbbbbbbbbb"
    assert len({long_id.removeprefix("lt_"), short_id.removeprefix("st_")}) == 2


def test_manager_generated_ids_keep_the_complete_128_bit_uuid(monkeypatch) -> None:
    monkeypatch.setattr(
        manager_module.uuid,
        "uuid4",
        _uuid_sequence(
            "abcdef01aaaaaaaaaaaaaaaaaaaaaaaa",
            "abcdef01bbbbbbbbbbbbbbbbbbbbbbbb",
            "abcdef01cccccccccccccccccccccccc",
        ),
    )
    memory = object.__new__(MemoryManager)
    memory.store = _RecordingStore()

    ids = [
        memory.store_fact("p", layer="permanent", source_type="user_profile"),
        memory.store_fact("l", layer="long_term", source_type="user_profile"),
        memory.store_fact("s", layer="short_term", source_type="user_profile"),
    ]

    assert ids == [
        "perm_abcdef01aaaaaaaaaaaaaaaaaaaaaaaa",
        "lt_abcdef01bbbbbbbbbbbbbbbbbbbbbbbb",
        "st_abcdef01cccccccccccccccccccccccc",
    ]
    assert all(len(memory_id.rsplit("_", 1)[1]) == 32 for memory_id in ids)

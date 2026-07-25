import asyncio
from unittest.mock import MagicMock

from src.main import memory_maintenance_loop


class FakeMemory:
    def __init__(self, called: asyncio.Event) -> None:
        self.calls = 0
        self.called = called

    async def run_maintenance(self) -> dict:
        self.calls += 1
        self.called.set()
        return {"forgotten": 1, "misremembered": 0}


def test_memory_maintenance_loop_runs_scheduled_cycle() -> None:
    async def exercise() -> tuple[FakeMemory, MagicMock]:
        called = asyncio.Event()
        memory = FakeMemory(called)
        logger = MagicMock()
        task = asyncio.create_task(memory_maintenance_loop(memory, logger, interval_seconds=0.001))
        await asyncio.wait_for(called.wait(), timeout=1.0)
        task.cancel()
        await task
        return memory, logger

    memory, logger = asyncio.run(exercise())

    assert memory.calls >= 1
    logger.info.assert_called()

"""Quick integration test: send one message and check the full pipeline."""
import sys
sys.path.insert(0, ".")

import asyncio
import logging
from src.utils.logger import setup_logger
setup_logger("test", logging.WARNING)

from src.config.settings import load_settings
from src.api.adapter import LLMAdapter
from src.persona.persona_card import default_persona
from src.emotion.system import EmotionSystem
from src.relationship.tracker import RelationshipTracker
from src.chat.scheduler import MessageScheduler
from src.cloud.base import create_cloud_service
from src.memory.manager import MemoryManager
from src.chat.session import ChatSession


async def main():
    s = load_settings()
    p = default_persona()
    a = LLMAdapter(s.llm)
    e = EmotionSystem()
    r = RelationshipTracker(50)
    sc = MessageScheduler()
    mm = MemoryManager(p)
    sess = ChatSession(p, a, mm, e, r, scheduler=sc)

    result = await sess.send_message("Hello!")
    print("REPLY:", result["reply"][:300])
    print("DELAY:", result["delay"])
    print("BUBBLES:", len(result["messages"]))
    print("EMOTIONS:", result["emotion_changes"])
    print("INJECTION:", result["injection_detected"])

asyncio.run(main())

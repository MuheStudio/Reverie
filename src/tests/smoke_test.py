import asyncio
import logging
from pathlib import Path
import sys

# Ensure src is importable
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from src.config.settings import load_settings
from src.persona.persona_card import default_persona
from src.chat.scheduler import MessageScheduler
from src.chat.session import ChatSession
from src.social.circle import SocialCircle
from src.interest.tracker import InterestTracker

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("smoke_test")

async def run_smoke_test():
    logger.info("Starting smoke test...")
    
    try:
        settings = load_settings()
        logger.info("Settings loaded.")
        
        persona = default_persona()
        logger.info(f"Persona created: {persona.name}")
        
        scheduler = MessageScheduler()
        logger.info("Scheduler initialized.")
        
        social = SocialCircle(data_dir=Path("data/test_social"))
        logger.info("SocialCircle initialized.")
        
        interest = InterestTracker(data_dir=Path("data/test_interest"))
        logger.info("InterestTracker initialized.")
        
        logger.info("Smoke test passed successfully!")
        
    except Exception as e:
        logger.error(f"Smoke test failed: {e}")
        sys.exit(1)

if __name__ == "__main__":
    asyncio.run(run_smoke_test())

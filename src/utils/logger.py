"""Simple structured logger for Reverie."""

import logging
import sys
from pathlib import Path


def setup_logger(
    name: str = "reverie",
    level: int = logging.INFO,
    log_file: Path | None = None,
) -> logging.Logger:
    """Create a logger with console output and optional file output."""
    logger = logging.getLogger(name)
    logger.setLevel(level)

    if logger.handlers:
        return logger  # already configured

    fmt = logging.Formatter(
        "%(asctime)s  %(levelname)-7s  %(name)s  %(message)s",
        datefmt="%H:%M:%S",
    )

    # Console handler
    ch = logging.StreamHandler(sys.stderr)
    ch.setLevel(level)
    ch.setFormatter(fmt)
    logger.addHandler(ch)

    # File handler (optional)
    if log_file:
        fh = logging.FileHandler(log_file, encoding="utf-8")
        fh.setLevel(logging.DEBUG)
        fh.setFormatter(fmt)
        logger.addHandler(fh)

    return logger

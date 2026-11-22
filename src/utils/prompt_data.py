"""Neutralize tag-shaped text inside existing untrusted prompt blocks."""

import re

_TAG_PREFIX = re.compile(r"<(?=[/!?]|[^\W\d])")


def neutralize_prompt_tags(text: str) -> str:
    return _TAG_PREFIX.sub("< ", text)

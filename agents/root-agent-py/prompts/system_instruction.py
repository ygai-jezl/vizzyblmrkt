"""Root agent system instruction.

Source of truth for the LlmAgent's base system prompt. Brand context is layered
on top dynamically by context.brand_context.build_dynamic_instruction().
"""

from __future__ import annotations

from pathlib import Path

_PROMPT_PATH = Path(__file__).parent / "_system_text.txt"

ROOT_SYSTEM_INSTRUCTION: str = _PROMPT_PATH.read_text(encoding="utf-8").strip()

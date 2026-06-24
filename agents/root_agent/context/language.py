"""Operator content-language directive for the root agent.

Mirrors the TypeScript src/lib/i18n/locale.ts: there is NO language config field
for Gemini text, so the reply language is steered purely by a system-instruction
directive. The chat proxy passes the resolved operator locale in the `[ctx:{...}]`
envelope (omitted for English); `build_dynamic_instruction` prepends this directive.

Pure helper — no ADK imports — so it stays unit-testable without ADK installed.
"""

from __future__ import annotations

from typing import Optional

# Base-code -> English name. Kept in sync with the `LOCALES` table in
# src/lib/i18n/locale.ts (the admin picker validates against that same set).
LANGUAGE_NAMES = {
    "en": "English",
    "es": "Spanish",
    "fr": "French",
    "de": "German",
    "it": "Italian",
    "pt": "Portuguese",
    "nl": "Dutch",
    "pl": "Polish",
    "ro": "Romanian",
    "ru": "Russian",
    "uk": "Ukrainian",
    "tr": "Turkish",
    "ar": "Arabic",
    "hi": "Hindi",
    "bn": "Bengali",
    "mr": "Marathi",
    "ta": "Tamil",
    "te": "Telugu",
    "th": "Thai",
    "vi": "Vietnamese",
    "id": "Indonesian",
    "ja": "Japanese",
    "ko": "Korean",
    "zh": "Chinese (Simplified)",
}

DEFAULT_LOCALE = "en"


def normalize_locale(code: Optional[str]) -> Optional[str]:
    """Coerce a BCP-47 / region-tagged string down to a supported base code, or None."""
    if not code or not isinstance(code, str):
        return None
    base = code.strip().lower().replace("_", "-").split("-")[0]
    return base if base in LANGUAGE_NAMES else None


def language_directive(code: Optional[str]) -> str:
    """System-instruction sentence steering the agent to reply in `code`.

    Returns "" for English / unknown so the English path is byte-for-byte
    unchanged. The root agent's output is conversational markdown (no JSON/HTML
    contract), so this is deliberately leaner than the email/voice directive.
    """
    norm = normalize_locale(code)
    if not norm or norm == DEFAULT_LOCALE:
        return ""
    name = LANGUAGE_NAMES[norm]
    return (
        f"RESPOND IN {name}. Write every reply to the operator in {name}, "
        f"unless the operator explicitly asks for another language."
    )

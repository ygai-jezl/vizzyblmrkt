"""Dynamic system instruction builder.

Layers brand context (name, domain, industry) onto the base root prompt so the
agent doesn't ask for info we already have.

Reads `brandSettings` from session state when something puts it there, and falls back to the
base prompt when absent (nothing does today). What the brand told Vizzy about its business (its
name, the four answers and the facts an admin kept) reaches the root agent another way: the
`apply_business_profile` before-model callback (callbacks/business_profile.py) fetches it when the
envelope's `profileRev` changes, caches it in process (never in session state) and appends a
fenced block to each model call; the sub-agents' instruction builders append the same cached
block. The agent never reads Firestore.

ADK's ReadonlyContext is imported under TYPE_CHECKING so this module (and
`_format_brand_block`) stays importable without ADK installed.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Dict

from ..prompts.system_instruction import ROOT_SYSTEM_INSTRUCTION
from .language import language_directive

if TYPE_CHECKING:
    from google.adk.agents.readonly_context import ReadonlyContext


def _format_brand_block(brand: Dict[str, Any]) -> str:
    if not brand or not brand.get("brandName"):
        return ""

    industries = brand.get("industries") or []
    competitors = (brand.get("confirmedCompetitors") or [])[:5]
    description = (brand.get("brandAnalysis") or {}).get("industryDescription")

    lines = ["## Current Brand Context", "You are assisting with the following brand:"]
    lines.append(f"- **Brand Name:** {brand['brandName']}")
    lines.append(f"- **Primary Domain:** {brand.get('primaryDomain') or 'Not configured'}")
    if industries:
        lines.append(f"- **Industry:** {', '.join(industries)}")
    if competitors:
        lines.append(f"- **Key Competitors:** {', '.join(competitors)}")
    if description:
        lines.append(f"- **Description:** {description}")
    lines.append("")
    lines.append(
        "Use this context to provide relevant, brand-specific responses. You do "
        "NOT need to ask for the brand name or domain — you already have it."
    )
    return "\n".join(lines)


PERSON_IN_VIEW_BLOCK = (
    "## The person in view\n"
    "That page is one person's. For anything about \"this person\" (what has happened, why "
    "they stalled, what they should get next, their fields such as plan, seats or status, or a "
    "change to suggest), delegate to the Lifecycle Ops specialist (`lifecycle_ops_agent`), which "
    "can read their situation and their fields. You are never told who they are: "
    "don't ask for a name or an email address, and don't repeat one the operator types."
)


def build_dynamic_instruction(ctx: "ReadonlyContext") -> str:
    """Callable instruction. ADK invokes this each turn to build the system prompt."""
    state = getattr(ctx, "state", None) if ctx else None
    brand_settings = (state.get("brandSettings") if state else None) or None
    # Operator content language, forwarded by the chat proxy in the [ctx:] envelope
    # (absent/"en" ⇒ no directive, so the English path is unchanged).
    locale = state.get("locale") if state else None

    base = ROOT_SYSTEM_INSTRUCTION
    brand_block = _format_brand_block(brand_settings) if brand_settings else ""
    instruction = f"{brand_block}\n\n{base}" if brand_block else base

    directive = language_directive(locale)
    if directive:
        # Prepend so the language constraint is the first thing the model reads.
        instruction = f"{directive}\n\n{instruction}"

    # The admin page the operator is chatting from (the Ask Vizzy panel sends its
    # breadcrumb in the [ctx:] envelope, e.g. "Launches › Beta › Signups"). Appended
    # so "this launch" / "here" resolve to what is on screen.
    page_block = _format_page_block(state.get("page") if state else None)
    if page_block:
        instruction = f"{instruction}\n\n{page_block}"
    # One person's page (the app sends `personId` only while their situation or fields can be read).
    if state and state.get("personId"):
        instruction = f"{instruction}\n\n{PERSON_IN_VIEW_BLOCK}"
    return instruction


def _format_page_block(page: Any) -> str:
    """One line naming the admin page in view, or "" when there is none."""
    if not isinstance(page, str):
        return ""
    page = " ".join(page.split())[:160]
    if not page:
        return ""
    return (
        "## Where the admin is\n"
        f"They are looking at this page of the YouGrow admin: {page}. "
        'When they say "this" or "here", assume they mean what is on that page.'
    )

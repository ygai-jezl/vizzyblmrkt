"""Dynamic system instruction builder.

Layers brand context (name, domain, industry) onto the base root prompt so the
agent doesn't ask for info we already have.

Phase 2: reads `brandSettings` from session state (populated by the proxy / a
session-start hook) and falls back to the base prompt when absent — NO Firestore
reads from inside the agent yet. The Firestore-backed hydration
(`hydrate_brand_settings_into_state`, regional DB routing, tenant membership
gating) lands in Phase 3 alongside the marketing tools that also need it.

ADK's ReadonlyContext is imported under TYPE_CHECKING so this module (and
`_format_brand_block`) stays importable without ADK installed.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Dict

from ..prompts.system_instruction import ROOT_SYSTEM_INSTRUCTION

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


def build_dynamic_instruction(ctx: "ReadonlyContext") -> str:
    """Callable instruction. ADK invokes this each turn to build the system prompt."""
    state = getattr(ctx, "state", None) if ctx else None
    brand_settings = (state.get("brandSettings") if state else None) or None

    base = ROOT_SYSTEM_INSTRUCTION
    if not brand_settings:
        return base

    brand_block = _format_brand_block(brand_settings)
    return f"{brand_block}\n\n{base}" if brand_block else base

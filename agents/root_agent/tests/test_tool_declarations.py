"""The root agent's FunctionTools build ADK declarations (needs ADK; skipped without it).

ADK finds the injected `tool_context` by resolving each tool's annotations at
runtime, so a wrapper module that stringifies them (`from __future__ import
annotations`) would leak `tool_context` into the declaration or crash the turn.
"""

from __future__ import annotations

import inspect

import pytest

pytest.importorskip("google.adk")

from google.adk.tools import FunctionTool, ToolContext  # noqa: E402

from root_agent_pkg.tools.email_style import get_email_style, suggest_email_style  # noqa: E402
from root_agent_pkg.tools.insights_summary import get_insights_summary  # noqa: E402
from root_agent_pkg.tools.retrieve_knowledge import retrieve_knowledge  # noqa: E402

TOOLS = [retrieve_knowledge, get_insights_summary, get_email_style, suggest_email_style]


def _params(declaration) -> "tuple[dict, list]":
    """(properties, required), whichever schema form this ADK version builds."""
    schema = declaration.parameters_json_schema
    if schema is not None:
        return schema.get("properties", {}), schema.get("required", [])
    params = declaration.parameters
    return (params.properties or {}, params.required or []) if params else ({}, [])


@pytest.mark.filterwarnings("ignore::UserWarning")
@pytest.mark.parametrize("fn", TOOLS, ids=lambda f: f.__name__)
def test_declarations_build_without_tool_context(fn):
    assert inspect.signature(fn).parameters["tool_context"].annotation is ToolContext
    declaration = FunctionTool(fn)._get_declaration()
    assert declaration.name == fn.__name__
    props, _ = _params(declaration)
    assert "tool_context" not in props


@pytest.mark.filterwarnings("ignore::UserWarning")
def test_suggest_email_style_asks_for_the_mode_and_brief_only():
    props, required = _params(FunctionTool(suggest_email_style)._get_declaration())
    assert set(props) == {
        "mode",
        "brief",
        "header_color",
        "header_gradient_color",
        "solid_header",
        "header_text_color",
        "header_image",
        "button_color",
        "logo",
        "company_name",
        "hide_company_name",
        "theme",
        "heading_font",
        "body_font",
        "use_brand_fonts",
    }
    assert sorted(required) == ["brief", "mode"]


def test_the_root_agent_carries_the_email_style_tools():
    from root_agent_pkg.agent import root_agent

    assert get_email_style in root_agent.tools and suggest_email_style in root_agent.tools

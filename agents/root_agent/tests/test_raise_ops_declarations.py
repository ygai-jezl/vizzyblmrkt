"""The Raise Ops tools build ADK declarations, and the root carries the agent (needs ADK; skipped without it).

Kept apart from test_tool_declarations.py so other slices can add their tools there without a clash.
"""

from __future__ import annotations

import inspect

import pytest

pytest.importorskip("google.adk")

from google.adk.tools import FunctionTool, ToolContext  # noqa: E402

from root_agent_pkg.sub_agents.raise_ops.agent import raise_ops_agent  # noqa: E402
from root_agent_pkg.sub_agents.raise_ops.tools.raise_tools import draft_raise_doc, get_raise_doc, revise_raise_doc  # noqa: E402

TOOLS = [draft_raise_doc, get_raise_doc, revise_raise_doc]


def _params(declaration) -> "tuple[dict, list]":
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
def test_each_tool_asks_for_what_it_needs():
    props, required = _params(FunctionTool(draft_raise_doc)._get_declaration())
    assert set(props) == {"audience", "stage", "title", "brief"} and required == ["audience"]
    props, required = _params(FunctionTool(get_raise_doc)._get_declaration())
    assert set(props) == {"doc_id"} and not required
    props, required = _params(FunctionTool(revise_raise_doc)._get_declaration())
    assert set(props) == {
        "change", "slide", "after", "to", "ask", "section", "layout", "meaning", "weeks", "launch",
        "name", "value", "unit", "currency", "per", "source_note", "quote", "note", "version", "doc_id",
    }
    assert required == ["change"]


def test_raise_ops_carries_the_three_tools_and_the_root_delegates_to_it():
    from root_agent_pkg.agent import root_agent

    assert raise_ops_agent.name == "raise_ops_agent"
    assert [t.__name__ for t in raise_ops_agent.tools] == ["draft_raise_doc", "get_raise_doc", "revise_raise_doc"]
    assert raise_ops_agent in root_agent.sub_agents
    assert [a.name for a in root_agent.sub_agents][-1] == "raise_ops_agent"

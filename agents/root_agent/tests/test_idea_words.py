"""Vizzy and the two names of a launch (ADK-free).

The app may call a launch an idea (piece D: NEXT_PUBLIC_NAV_IDEAS_ENABLED and LAUNCH_IDEAS_ENABLED),
and Vizzy can't read that switch. So the root, Campaign Ops and Lifecycle Ops instructions carry
one glossary line, and every message a tool hands Vizzy to relay says waitlist, or both words,
never launch alone. Docstrings and the values the app reads (scope "launch", `launch_not_found`)
keep launch.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

from root_agent_pkg.prompts.system_instruction import ROOT_SYSTEM_INSTRUCTION
from root_agent_pkg.sub_agents.campaign_ops.instruction_builder import build_campaign_ops_instruction
from root_agent_pkg.sub_agents.campaign_ops.prompts.instruction import CAMPAIGN_OPS_INSTRUCTION
from root_agent_pkg.sub_agents.lifecycle_ops.instruction_builder import build_lifecycle_ops_instruction
from root_agent_pkg.sub_agents.lifecycle_ops.prompts.instruction import LIFECYCLE_OPS_INSTRUCTION
from root_agent_pkg.sub_agents.campaign_ops.tools import canvas_client as cc
from root_agent_pkg.sub_agents.lifecycle_ops.tools import lifecycle_client as lc
from root_agent_pkg.tools import journey_style_client as js
from root_agent_pkg.tools import knowledge_client as kc
from root_agent_pkg.tools import results_client as rc

GLOSSARY = "The app may call a launch an idea; same thing, same id."

_ROOT = Path(__file__).resolve().parent.parent
# Where tool code lives: each module's strings are what a tool can hand Vizzy.
_TOOL_MODULES = sorted([*_ROOT.glob("tools/*.py"), *_ROOT.glob("sub_agents/*/tools/*.py")])
_LAUNCH = re.compile(r"\blaunch(es)?\b", re.IGNORECASE)


class _Ctx:
    def __init__(self, state):
        self.state = state


def _sentences(path: Path) -> list[tuple[int, str]]:
    """Each string in a module that reads as words (it has a space), docstrings left out.

    An f-string reads with its placeholders as {}. Comments aren't in the tree, so they're left out
    too, as are values such as "launch" and "launch_not_found".
    """
    tree = ast.parse(path.read_text(encoding="utf-8"))
    skip: set[int] = set()
    for node in ast.walk(tree):
        body = getattr(node, "body", None)
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and body:
            first = body[0]
            if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
                skip.add(id(first.value))
    out: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.JoinedStr):
            for part in node.values:
                skip.add(id(part))
            out.append((node.lineno, "".join(p.value if isinstance(p, ast.Constant) else "{}" for p in node.values)))
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in skip:
            out.append((node.lineno, node.value))
    return [(line, text) for line, text in out if " " in text]


def test_the_three_instructions_carry_the_glossary_once():
    for name, text in (
        ("root", ROOT_SYSTEM_INSTRUCTION),
        ("campaign_ops", CAMPAIGN_OPS_INSTRUCTION),
        ("lifecycle_ops", LIFECYCLE_OPS_INSTRUCTION),
    ):
        assert text.count(GLOSSARY) == 1, name
    # And it reaches each specialist whatever the operator's language.
    for build in (build_campaign_ops_instruction, build_lifecycle_ops_instruction):
        for state in ({}, {"locale": "de"}):
            assert GLOSSARY in build(_Ctx(state))


def test_the_root_keeps_tool_arguments_as_they_are():
    # The app still reads scope "launch" and a launch's campaign id, whatever it calls it.
    assert 'keep tool arguments as they are (scope "launch", a launch\'s campaign id)' in ROOT_SYSTEM_INSTRUCTION


def test_no_tool_hands_vizzy_launch_without_idea():
    found = []
    for path in _TOOL_MODULES:
        for line, text in _sentences(path):
            if _LAUNCH.search(text) and "idea" not in text.lower():
                found.append(f"{path.relative_to(_ROOT)}:{line}: {text}")
    assert found == [], "\n".join(found)


def test_the_check_reads_messages_and_skips_docstrings(tmp_path):
    module = tmp_path / "sample_client.py"
    module.write_text(
        '"""A launch\'s tool."""\n'
        "SCOPES = (\"launch\",)\n"
        "_ERRORS = {\"launch_not_found\": \"I couldn't find that launch.\"}\n"
        "def f(x):\n"
        "    \"\"\"Reads a launch.\"\"\"\n"
        "    return f\"Nothing for this launch yet: {x}\"\n",
        encoding="utf-8",
    )
    assert sorted(text for _, text in _sentences(module)) == ["I couldn't find that launch.", "Nothing for this launch yet: {}"]


def test_relayed_messages_say_waitlist():
    assert cc.parse_invite_wave_response(404, '{"error": "campaign_not_found"}')["message"] == "I couldn't find that waitlist in this account."
    assert "this waitlist yet" in cc.parse_invite_wave_response(409, '{"error": "invites_locked"}')["message"]
    assert cc.draft_invite_wave_via_canvas({"ctxToken": "t"}, "", "")["message"] == "Which waitlist should I invite?"
    assert js._ERRORS["launch_not_found"] == "I couldn't find that waitlist in this account."
    assert rc._ERRORS["not_found"] == "I couldn't find that waitlist or journey."
    assert kc.retrieve_knowledge_via_api({"ctxToken": "t"}, "", "pricing")["message"] == "Which waitlist's knowledge should I search?"
    assert lc._PERSON_ERRORS["person_only_launches"].startswith("This person has only joined your waitlists.")

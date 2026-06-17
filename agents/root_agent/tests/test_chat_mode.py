"""Unit tests for the [mode:...] directive parser (pure helper, no ADK needed)."""

from __future__ import annotations

from root_agent_pkg.callbacks.chat_mode import _strip_mode_directive


def test_strips_fast_directive():
    cleaned, mode = _strip_mode_directive("[mode:fast] do the thing")
    assert cleaned == "do the thing"
    assert mode == "fast"


def test_strips_thinking_directive():
    cleaned, mode = _strip_mode_directive("[mode:thinking] reason carefully")
    assert cleaned == "reason carefully"
    assert mode == "thinking"


def test_case_insensitive():
    cleaned, mode = _strip_mode_directive("[MODE:Thinking] x")
    assert cleaned == "x"
    assert mode == "thinking"


def test_leading_whitespace_and_no_space_after():
    cleaned, mode = _strip_mode_directive("   [mode:fast]go")
    assert cleaned == "go"
    assert mode == "fast"


def test_no_directive_returns_text_unchanged():
    cleaned, mode = _strip_mode_directive("plain message")
    assert cleaned == "plain message"
    assert mode is None


def test_unknown_mode_is_not_matched():
    text = "[mode:turbo] x"
    cleaned, mode = _strip_mode_directive(text)
    assert cleaned == text
    assert mode is None

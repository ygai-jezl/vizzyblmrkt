"""Unit tests for the [ctx:{...}] envelope parser (pure helper, no ADK needed)."""

from __future__ import annotations

from root_agent_pkg.callbacks.context_envelope import _extract_envelope


def test_extracts_and_strips_valid_envelope():
    cleaned, data = _extract_envelope(
        '[ctx:{"tenantId":"ten_vzb","userId":"u1","region":"us","traceId":"tr1"}] Hello there'
    )
    assert cleaned == "Hello there"
    assert data == {
        "tenantId": "ten_vzb",
        "userId": "u1",
        "region": "us",
        "traceId": "tr1",
    }


def test_leaves_mode_prefix_for_the_next_callback():
    # context_envelope runs BEFORE chat_mode and must only strip its own prefix.
    cleaned, data = _extract_envelope('  [ctx:{"tenantId":"t1"}]  [mode:fast] hi')
    assert cleaned == "[mode:fast] hi"
    assert data == {"tenantId": "t1"}


def test_no_envelope_returns_text_unchanged():
    cleaned, data = _extract_envelope("just a normal message")
    assert cleaned == "just a normal message"
    assert data is None


def test_malformed_json_is_ignored():
    text = "[ctx:{not valid json}] body"
    cleaned, data = _extract_envelope(text)
    assert cleaned == text
    assert data is None


def test_handles_multiline_message():
    cleaned, data = _extract_envelope('[ctx:{"tenantId":"t1"}] line one\nline two')
    assert cleaned == "line one\nline two"
    assert data == {"tenantId": "t1"}

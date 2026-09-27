"""Unit tests for the Email style tool client (ADK-free; the HTTP call is monkeypatched)."""

from __future__ import annotations

import json

from root_agent_pkg.prompts.system_instruction import ROOT_SYSTEM_INSTRUCTION
from root_agent_pkg.tools import email_style_client as es

STATE = {"ctxToken": "tok"}
JOURNEY_KEYS = {"journeyId", "journeyStatus", "waveId"}


def _capture(monkeypatch, status=200, body=None):
    calls = []

    def fake(method, url, token, payload=None):
        calls.append({"method": method, "url": url, "token": token, "payload": payload})
        return status, body if isinstance(body, str) else json.dumps(body if body is not None else {})

    monkeypatch.setattr(es, "_request", fake)
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com/")
    return calls


def test_reads_the_style_with_the_session_token(monkeypatch):
    calls = _capture(monkeypatch, 200, {"url": "/admin/brand-kit/email-style", "canSuggest": True, "current": None})
    out = es.get_style(STATE)
    assert out == {"status": "success", "url": "/admin/brand-kit/email-style", "canSuggest": True, "current": None}
    assert calls == [
        {"method": "GET", "url": "https://app.example.com/api/agent/email-style", "token": "tok", "payload": None}
    ]


def test_suggest_sends_only_the_fields_given(monkeypatch):
    calls = _capture(monkeypatch, 200, {"ok": True})
    es.suggest_style(STATE, "edit", "make the header navy", header_color=" #1B2A4A ")
    assert calls[0]["method"] == "POST"
    assert calls[0]["url"] == "https://app.example.com/api/agent/canvas"
    assert calls[0]["token"] == "tok"
    assert calls[0]["payload"] == {
        "kind": "email_style",
        "action": "save_draft",
        "mode": "edit",
        "brief": "make the header navy",
        "headerColor": "#1B2A4A",
    }
    full = es.build_suggest_payload("brand_kit", "use my brand kit", "#111111", "#ff6b35", "primary", "Acme")
    assert full == {
        "kind": "email_style",
        "action": "save_draft",
        "mode": "brand_kit",
        "brief": "use my brand kit",
        "headerColor": "#111111",
        "buttonColor": "#ff6b35",
        "logo": "primary",
        "companyName": "Acme",
    }


def test_hide_company_name_sends_null():
    p = es.build_suggest_payload("edit", "logo only please", company_name="Acme", hide_company_name=True)
    assert "companyName" in p and p["companyName"] is None
    assert "companyName" not in es.build_suggest_payload("edit", "", company_name="  ")


def test_a_long_brief_is_cut_to_what_the_server_keeps():
    assert len(es.build_suggest_payload("edit", "x" * 4000)["brief"]) == 500


def test_no_token_or_callback_says_it_cant_reach_the_app(monkeypatch):
    monkeypatch.setattr(es, "_request", lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("no call expected")))
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com")
    outs = [es.get_style({}), es.suggest_style(None, "brand_kit", "")]
    monkeypatch.delenv("CANVAS_CALLBACK_URL")
    outs += [es.get_style(STATE), es.suggest_style(STATE, "brand_kit", "")]
    for out in outs:
        assert out["status"] == "error"
        assert "can't reach the app" in out["message"]
        assert "switched on" not in out["message"]


def test_errors_become_plain_messages(monkeypatch):
    off = "Email style isn't switched on in this environment yet."
    for status, body, code, says in [
        (503, {"error": "unavailable"}, "unavailable", off),
        (400, {"error": "unknown_kind", "known": ["journey"]}, "unknown_kind", off),
        (404, "<html>Not found</html>", "http_404", off),
        (403, {"error": "forbidden"}, "forbidden", "Only an admin can suggest an email style"),
        (401, {"error": "unauthorized", "reason": "expired"}, "unauthorized", "session to the app expired"),
        (429, {"error": "rate_limited"}, "rate_limited", "try again in a few minutes"),
        (400, {"error": "invalid_input", "issues": ["headerColor: Invalid"]}, "invalid_input", "headerColor: Invalid"),
        (400, {"error": "invalid_logo", "issues": ["logo: not one of your logos"]}, "invalid_logo", "not one of your logos"),
        (0, {"error": "network_error", "detail": "timed out"}, "network_error", "couldn't reach the app"),
        (500, "not json", "http_500", "Please try again"),
    ]:
        _capture(monkeypatch, status, body)
        for out in (es.get_style(STATE), es.suggest_style(STATE, "edit", "")):
            assert out["status"] == "error" and out["code"] == code
            assert says in out["message"]
            # Only the feature being off (or the app predating it) says "switched on".
            assert ("switched on" in out["message"]) == (says == off)


def test_success_relays_the_card_without_journey_keys(monkeypatch):
    card = {
        "kind": "email_style",
        "id": "email_style",
        "title": "Email style suggestion",
        "url": "/admin/brand-kit/email-style",
        "stats": [{"label": "header", "value": "#1b2a4a"}, {"label": "button", "value": "#ff6b35"}],
        "warnings": 0,
        "note": "Suggestion — nothing changes until an admin applies it.",
        "cta": "Review and apply",
    }
    _capture(
        monkeypatch,
        200,
        {
            "ok": True,
            "kind": "email_style",
            "id": "email_style",
            "journeyId": "email_style",
            "status": "suggested",
            "url": card["url"],
            "warnings": [],
            "summary": "Suggested an Email style. It's only a suggestion.",
            "card": card,
        },
    )
    out = es.suggest_style(STATE, "brand_kit", "use my brand kit for my emails")
    assert out == {
        "status": "success",
        "url": card["url"],
        "warnings": [],
        "card": card,
        "message": "Suggested an Email style. It's only a suggestion.",
    }
    assert not JOURNEY_KEYS & set(out)


def test_root_routes_email_style_to_the_tools_as_a_suggestion():
    assert "get_email_style" in ROOT_SYSTEM_INSTRUCTION
    assert "suggest_email_style" in ROOT_SYSTEM_INSTRUCTION
    assert "only a suggestion" in ROOT_SYSTEM_INSTRUCTION
    assert "not one email in a journey" in ROOT_SYSTEM_INSTRUCTION

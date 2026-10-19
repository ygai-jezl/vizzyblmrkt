"""Unit tests for the image style tool client (ADK-free; the HTTP call is monkeypatched)."""

from __future__ import annotations

import json

from root_agent_pkg.prompts.system_instruction import ROOT_SYSTEM_INSTRUCTION
from root_agent_pkg.tools import image_style_client as ims

STATE = {"ctxToken": "tok"}


def _capture(monkeypatch, status=200, body=None):
    calls = []

    def fake(method, url, token, payload=None):
        calls.append({"method": method, "url": url, "token": token, "payload": payload})
        return status, body if isinstance(body, str) else json.dumps(body if body is not None else {})

    monkeypatch.setattr(ims, "_request", fake)
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com/")
    return calls


def test_reads_the_style_with_the_session_token(monkeypatch):
    calls = _capture(monkeypatch, 200, {"url": "/admin/brand-kit/image-style", "canSuggest": True, "current": None})
    out = ims.get_style(STATE)
    assert out == {"status": "success", "url": "/admin/brand-kit/image-style", "canSuggest": True, "current": None}
    assert calls == [{"method": "GET", "url": "https://app.example.com/api/agent/image-style", "token": "tok", "payload": None}]


def test_suggest_sends_the_default_any_channel_and_why(monkeypatch):
    calls = _capture(monkeypatch, 200, {"ok": True, "summary": "Suggested Product noir.", "url": "/admin/brand-kit/image-style"})
    out = ims.suggest_style(STATE, "Product noir", " Your site shows dark product screens. ", "make our images moodier", {"Instagram": "soft-3d", "tiktok": "x", "x": ""})
    assert calls[0]["url"] == "https://app.example.com/api/agent/canvas"
    assert calls[0]["payload"] == {
        "kind": "image_style",
        "action": "save_draft",
        "brief": "make our images moodier",
        "defaultStyleId": "product_noir",
        "reason": "Your site shows dark product screens.",
        "channels": {"instagram": "soft_3d"},
    }
    assert out["status"] == "success"
    assert out["message"] == "Suggested Product noir."


def test_says_what_went_wrong(monkeypatch):
    _capture(monkeypatch, 403, {"error": "forbidden"})
    assert ims.suggest_style(STATE, "soft_3d", "x", "y")["message"].startswith("Only an admin can suggest")
    _capture(monkeypatch, 400, {"error": "style_not_built", "issues": ["default: Type poster isn't available yet"]})
    assert ims.suggest_style(STATE, "type_poster", "x", "y")["message"] == "That style isn't available yet: default: Type poster isn't available yet"
    _capture(monkeypatch, 503, {"error": "unavailable"})
    assert ims.get_style(STATE)["message"] == "Image styles aren't switched on in this environment yet."


def test_needs_a_session(monkeypatch):
    monkeypatch.delenv("CANVAS_CALLBACK_URL", raising=False)
    assert ims.get_style({})["code"] == "not_connected"


def test_the_instruction_routes_image_style_questions_here():
    assert "get_image_style" in ROOT_SYSTEM_INSTRUCTION
    assert "suggest_image_style" in ROOT_SYSTEM_INSTRUCTION

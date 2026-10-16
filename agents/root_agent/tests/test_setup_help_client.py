"""Unit tests for the setup guide tool client (ADK-free; the HTTP call is monkeypatched)."""

from __future__ import annotations

import json

from root_agent_pkg.prompts.system_instruction import ROOT_SYSTEM_INSTRUCTION
from root_agent_pkg.tools import setup_help_client as sc


def test_fetches_the_setup_status_with_the_session_token(monkeypatch):
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com/")
    seen = {}

    def fake(url, token):
        seen.update(url=url, token=token)
        return 200, json.dumps({"nextStep": {"label": "Verify your sending domain"}})

    monkeypatch.setattr(sc, "_get", fake)
    out = sc.get_status({"ctxToken": "tok"})
    assert out["status"] == "success"
    assert out["nextStep"] == {"label": "Verify your sending domain"}
    assert seen == {"url": "https://app.example.com/api/agent/setup", "token": "tok"}


def test_reads_a_help_page_by_name(monkeypatch):
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com")
    seen = {}

    def fake(url, token):
        seen["url"] = url
        return 200, json.dumps({"title": "Email sending", "markdown": "# Set up email sending"})

    monkeypatch.setattr(sc, "_get", fake)
    out = sc.get_help_page({"ctxToken": "tok"}, " Email-Sending ")
    assert out["status"] == "success" and out["markdown"].startswith("# ")
    assert seen["url"] == "https://app.example.com/api/agent/help?page=email-sending"


def test_refuses_a_page_name_that_isnt_one_without_a_call(monkeypatch):
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com")
    monkeypatch.setattr(sc, "_get", lambda *_: (_ for _ in ()).throw(AssertionError("no call expected")))
    for bad in ["", "../admin", "email sending", "x" * 61]:
        assert sc.get_help_page({"ctxToken": "tok"}, bad)["code"] == "not_found"


def test_unavailable_without_a_token_or_a_callback_url(monkeypatch):
    monkeypatch.setattr(sc, "_get", lambda *_: (_ for _ in ()).throw(AssertionError("no call expected")))
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com")
    assert sc.get_status({})["status"] == "unavailable"
    monkeypatch.delenv("CANVAS_CALLBACK_URL")
    assert sc.get_status({"ctxToken": "tok"})["status"] == "unavailable"


def test_errors_become_plain_messages_and_list_the_pages(monkeypatch):
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com")
    monkeypatch.setattr(sc, "_get", lambda *_: (404, json.dumps({"error": "not_found", "pages": ["get-set-up"]})))
    out = sc.get_help_page({"ctxToken": "tok"}, "nope")
    assert out["status"] == "error" and out["pages"] == ["get-set-up"] and out["message"]
    for status, body, code in [
        (503, {"error": "unavailable"}, "unavailable"),
        (401, {"error": "unauthorized"}, "unauthorized"),
        (429, {"error": "rate_limited"}, "rate_limited"),
        (500, "not json", "http_500"),
    ]:
        monkeypatch.setattr(sc, "_get", lambda *_, s=status, b=body: (s, b if isinstance(b, str) else json.dumps(b)))
        out = sc.get_status({"ctxToken": "tok"})
        assert out["status"] == "error" and out["code"] == code and out["message"]


def test_root_answers_setup_questions_from_the_tools():
    assert "get_setup_status" in ROOT_SYSTEM_INSTRUCTION
    assert "read_help_page" in ROOT_SYSTEM_INSTRUCTION

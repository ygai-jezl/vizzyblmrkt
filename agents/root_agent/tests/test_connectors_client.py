"""Unit tests for the connected data tool client (ADK-free; the HTTP call is monkeypatched)."""

from __future__ import annotations

import json

from root_agent_pkg.prompts.system_instruction import ROOT_SYSTEM_INSTRUCTION
from root_agent_pkg.tools import connectors_client as cc

STATE = {"ctxToken": "tok"}
CONN = "dcn_aaaaaaaaaaaaaaaaaaaa"


def _capture(monkeypatch, status=200, body=None):
    calls = []

    def fake(method, url, token, payload=None, timeout=cc._TIMEOUT_SECONDS):
        calls.append({"method": method, "url": url, "token": token, "payload": payload})
        return status, json.dumps(body if body is not None else {})

    monkeypatch.setattr(cc, "_request", fake)
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com/")
    return calls


def test_lists_connections_with_the_session_token(monkeypatch):
    calls = _capture(monkeypatch, 200, {"connections": [{"id": CONN, "canRead": True}], "notShared": False, "meanings": {}})
    out = cc.list_connections(STATE)
    assert out["status"] == "success" and out["connections"][0]["id"] == CONN
    assert calls == [{"method": "GET", "url": "https://app.example.com/api/agent/connectors", "token": "tok", "payload": None}]


def test_reads_live_with_a_bounded_request_and_never_a_brand(monkeypatch):
    calls = _capture(monkeypatch, 200, {"rows": [{"day": "2026-11-10", "searchClicks": 5}], "meanings": {"searchClicks": {"name": "Search clicks"}}})
    out = cc.read_connected_live(STATE, CONN, "search_performance", "2026-11-01", "2026-11-10", "page", 9999)
    assert out["status"] == "success" and out["meanings"]["searchClicks"]["name"] == "Search clicks"
    assert calls[0]["method"] == "POST" and calls[0]["url"] == "https://app.example.com/api/agent/connectors/live"
    assert calls[0]["payload"] == {"connectionId": CONN, "stream": "search_performance", "from": "2026-11-01", "to": "2026-11-10", "by": "page", "limit": 100}
    assert "tenant" not in json.dumps(calls[0]["payload"])
    cc.read_connected_live(STATE, CONN, "search_performance", "2026-11-01", "2026-11-01", "weekly", "lots")
    assert calls[1]["payload"]["by"] == "day" and calls[1]["payload"]["limit"] == 50


def test_checks_its_input_before_calling(monkeypatch):
    calls = _capture(monkeypatch)
    assert cc.read_connected_live(STATE, "", "search_performance", "2026-11-01", "2026-11-02")["code"] == "connection_required"
    assert cc.read_connected_live(STATE, "dcn_../x", "search_performance", "2026-11-01", "2026-11-02")["code"] == "connection_required"
    assert cc.read_connected_live(STATE, CONN, "search performance", "2026-11-01", "2026-11-02")["code"] == "invalid_input"
    assert cc.read_connected_live(STATE, CONN, "search_performance", "last week", "2026-11-02")["code"] == "invalid_input"
    assert cc.read_connected_live(STATE, CONN, "search_performance", "2026-11-05", "2026-11-02")["code"] == "bad_dates"
    assert cc.read_connected_live(STATE, CONN, "search_performance", "2026-01-01", "2026-11-02")["code"] == "too_many_days"
    assert calls == []


def test_says_plainly_when_vizzy_has_no_access_or_the_switch_is_off(monkeypatch):
    _capture(monkeypatch, 403, {"error": "no_agent_grant", "message": "from the app"})
    out = cc.read_connected_live(STATE, CONN, "search_performance", "2026-11-01", "2026-11-02")
    assert out["code"] == "no_agent_grant" and "An admin can let Vizzy read it" in out["message"]
    _capture(monkeypatch, 403, {"error": "no_read_grant"})
    assert "Members aren't allowed" in cc.read_connected_live(STATE, CONN, "search_performance", "2026-11-01", "2026-11-02")["message"]
    _capture(monkeypatch, 503, {"error": "unavailable"})
    assert cc.list_connections(STATE)["message"] == cc._OFF
    _capture(monkeypatch, 409, {"error": "share_not_visible", "message": "We can't see your property yet."})
    assert cc.read_connected_live(STATE, CONN, "site_traffic", "2026-11-01", "2026-11-02")["message"] == "We can't see your property yet."
    assert cc.list_connections({})["code"] == "not_connected"


def test_the_instruction_routes_connected_data_questions_and_never_claims_a_change():
    assert "list_connections" in ROOT_SYSTEM_INSTRUCTION
    assert "read_connected_live" in ROOT_SYSTEM_INSTRUCTION
    assert "an admin can allow Vizzy" in ROOT_SYSTEM_INSTRUCTION
    assert "never say you connected, changed, paused or disconnected anything" in ROOT_SYSTEM_INSTRUCTION

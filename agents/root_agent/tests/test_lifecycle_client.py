"""Unit tests for the Lifecycle Ops client (ADK-free; HTTP monkeypatched)."""

from __future__ import annotations

import json

from root_agent_pkg.sub_agents.lifecycle_ops.tools import lifecycle_client as lc

STATE = {"ctxToken": "tok", "connectionId": "pcn_page", "journeyId": "lcj_page"}


def _capture(monkeypatch, status=200, body=None):
    calls = []

    def fake(method, url, token, payload=None):
        calls.append({"method": method, "url": url, "token": token, "payload": payload})
        return status, json.dumps(body if body is not None else {})

    monkeypatch.setattr(lc, "_request", fake)
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com/")
    return calls


def test_template_payload_shape():
    p = lc.build_template_payload("pcn_1", None, "product_onboarding", {"days": 7}, "warm", "Onboarding")
    assert p == {
        "kind": "lifecycle",
        "action": "save_draft",
        "mode": "template",
        "template": "product_onboarding",
        "scope": {"connectionId": "pcn_1", "journeyId": None},
        "options": {"days": 7},
        "brief": "warm",
        "name": "Onboarding",
    }


def test_graph_payload_keeps_pools_and_settings_only_when_given():
    p = lc.build_graph_payload("pcn_1", "lcj_1", {"nodes": [], "edges": []}, None, None, "edit", None)
    assert p["mode"] == "graph" and p["scope"] == {"connectionId": "pcn_1", "journeyId": "lcj_1"}
    assert "pools" not in p and "settings" not in p and "name" not in p


def test_draft_uses_the_page_connection_and_relays_the_card(monkeypatch):
    card = {"kind": "lifecycle", "id": "lcj_new", "url": "/admin/lifecycle/lcj_new"}
    calls = _capture(monkeypatch, 200, {"ok": True, "id": "lcj_new", "status": "draft", "url": card["url"], "summary": "Drafted", "card": card, "warnings": []})
    out = lc.draft_journey(STATE, "", "product_onboarding", None, "warm", None, None)
    assert out["status"] == "success"
    assert out["card"] == card and out["journeyId"] == "lcj_new" and out["message"] == "Drafted"
    assert calls[0]["url"] == "https://app.example.com/api/agent/canvas"
    assert calls[0]["token"] == "tok"
    assert calls[0]["payload"]["scope"]["connectionId"] == "pcn_page"


def test_needs_a_connection_and_a_token():
    assert lc.draft_journey({"ctxToken": "tok"}, "", "product_onboarding", None, "", None, None)["status"] == "needs_connection"
    assert lc.draft_journey({}, "pcn_1", "product_onboarding", None, "", None, None)["status"] == "unavailable"


def test_errors_carry_structured_issues(monkeypatch):
    _capture(monkeypatch, 422, {"error": "invalid_graph", "issues": ["graph.nodes.0.type: invalid"]})
    out = lc.save_graph(STATE, "", None, {"nodes": [{"id": "x"}]}, None, None, "fix", None)
    assert out["status"] == "error" and out["code"] == "invalid_graph"
    assert out["issues"] == ["graph.nodes.0.type: invalid"]
    assert "graph.nodes.0.type" in out["message"]


def test_save_graph_edits_the_page_journey(monkeypatch):
    calls = _capture(monkeypatch, 200, {"ok": True, "id": "lcj_page", "status": "active", "summary": "Updated"})
    lc.save_graph(STATE, "", None, {"nodes": [], "edges": []}, [], {"x": 1}, "shorter", None)
    assert calls[0]["payload"]["scope"] == {"connectionId": "pcn_page", "journeyId": "lcj_page"}
    assert calls[0]["payload"]["pools"] == [] and calls[0]["payload"]["settings"] == {"x": 1}


def test_reads(monkeypatch):
    calls = _capture(monkeypatch, 200, {"connections": [], "journeys": []})
    assert lc.get_context(STATE)["status"] == "success"
    assert calls[0]["method"] == "GET" and calls[0]["url"].endswith("/api/agent/lifecycle/context")
    lc.get_journey(STATE, "")
    assert calls[1]["url"].endswith("/api/agent/lifecycle/journeys/lcj_page")
    assert lc.get_journey({"ctxToken": "tok"}, "")["status"] == "needs_journey"


def test_unavailable_is_explained(monkeypatch):
    _capture(monkeypatch, 503, {"error": "unavailable"})
    out = lc.get_context(STATE)
    assert out["status"] == "error" and "isn't switched on" in out["message"]

"""Unit tests for the canvas client behind the build_email_journey tool.

ADK-free: the pure logic lives in canvas_client.py (build_journey.py is just the
thin ADK-typed wrapper), and the HTTP call is monkeypatched.
"""

from __future__ import annotations

import json

from root_agent_pkg.sub_agents.campaign_ops.tools import canvas_client as cc


def test_build_request_payload_shape():
    payload = cc.build_request_payload("cmp_1", "welcome series", {"nodes": [], "edges": []})
    assert payload == {
        "kind": "journey",
        "campaignId": "cmp_1",
        "brief": "welcome series",
        "graph": {"nodes": [], "edges": []},
        "action": "save_draft",
    }


def test_build_request_payload_defaults_empty_graph():
    payload = cc.build_request_payload("cmp_1", "", None)
    assert payload["graph"] == {"nodes": [], "edges": []}
    assert payload["brief"] == ""


def test_parse_success():
    body = json.dumps(
        {"ok": True, "journeyId": "journey_cmp_1", "status": "draft", "warnings": [], "summary": "done"}
    )
    out = cc.parse_canvas_response(200, body)
    assert out["status"] == "success"
    assert out["journeyId"] == "journey_cmp_1"
    assert out["journeyStatus"] == "draft"
    assert out["message"] == "done"


def test_parse_journey_active_error():
    out = cc.parse_canvas_response(409, json.dumps({"error": "journey_active"}))
    assert out["status"] == "error"
    assert out["code"] == "journey_active"
    assert "pause" in out["message"].lower()


def test_parse_invalid_graph_includes_issues():
    out = cc.parse_canvas_response(
        422, json.dumps({"error": "invalid_graph", "issues": ["nodes: required"]})
    )
    assert out["status"] == "error"
    assert "nodes: required" in out["message"]


def test_parse_non_json_body():
    out = cc.parse_canvas_response(500, "<html>boom</html>")
    assert out["status"] == "error"
    assert out["code"] == "http_500"


def test_author_requires_token():
    out = cc.author_journey_via_canvas({}, "cmp_1", "brief", {})
    assert out["status"] == "unavailable"


def test_author_requires_campaign():
    out = cc.author_journey_via_canvas({"ctxToken": "tok"}, "", "brief", {})
    assert out["status"] == "needs_campaign"


def test_author_requires_callback_url(monkeypatch):
    monkeypatch.delenv("CANVAS_CALLBACK_URL", raising=False)
    out = cc.author_journey_via_canvas({"ctxToken": "tok"}, "cmp_1", "brief", {})
    assert out["status"] == "unavailable"


def test_author_happy_path(monkeypatch):
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com/")
    captured = {}

    def fake_post(url, payload, token):
        captured["url"] = url
        captured["payload"] = payload
        captured["token"] = token
        return 200, json.dumps(
            {"ok": True, "journeyId": "journey_cmp_1", "status": "draft", "warnings": [], "summary": "ok"}
        )

    monkeypatch.setattr(cc, "_post_canvas", fake_post)
    # campaign id falls back to session state; the callback path is appended once.
    out = cc.author_journey_via_canvas(
        {"ctxToken": "tok", "campaignId": "cmp_1"}, "", "welcome", {"nodes": [], "edges": []}
    )
    assert out["status"] == "success"
    assert out["journeyId"] == "journey_cmp_1"
    assert captured["url"] == "https://app.example.com/api/agent/canvas"
    assert captured["token"] == "tok"
    assert captured["payload"]["campaignId"] == "cmp_1"

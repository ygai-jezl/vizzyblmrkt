"""Unit tests for the build_email_journey tool (pure helpers + dispatch).

No ADK / network needed: the google.adk import is TYPE_CHECKING-only and the HTTP
call is monkeypatched.
"""

from __future__ import annotations

import json
import types

from root_agent_pkg.sub_agents.campaign_ops.tools import build_journey as bj


def _ctx(state: dict) -> types.SimpleNamespace:
    return types.SimpleNamespace(state=state)


def test_build_request_payload_shape():
    payload = bj.build_request_payload("cmp_1", "welcome series", {"nodes": [], "edges": []})
    assert payload == {
        "kind": "journey",
        "campaignId": "cmp_1",
        "brief": "welcome series",
        "graph": {"nodes": [], "edges": []},
        "action": "save_draft",
    }


def test_build_request_payload_defaults_empty_graph():
    payload = bj.build_request_payload("cmp_1", "", None)
    assert payload["graph"] == {"nodes": [], "edges": []}
    assert payload["brief"] == ""


def test_parse_success():
    body = json.dumps(
        {"ok": True, "journeyId": "journey_cmp_1", "status": "draft", "warnings": [], "summary": "done"}
    )
    out = bj.parse_canvas_response(200, body)
    assert out["status"] == "success"
    assert out["journeyId"] == "journey_cmp_1"
    assert out["journeyStatus"] == "draft"
    assert out["message"] == "done"


def test_parse_journey_active_error():
    out = bj.parse_canvas_response(409, json.dumps({"error": "journey_active"}))
    assert out["status"] == "error"
    assert out["code"] == "journey_active"
    assert "pause" in out["message"].lower()


def test_parse_invalid_graph_includes_issues():
    out = bj.parse_canvas_response(
        422, json.dumps({"error": "invalid_graph", "issues": ["nodes: required"]})
    )
    assert out["status"] == "error"
    assert "nodes: required" in out["message"]


def test_parse_non_json_body():
    out = bj.parse_canvas_response(500, "<html>boom</html>")
    assert out["status"] == "error"
    assert out["code"] == "http_500"


def test_dispatch_requires_token():
    out = bj.build_email_journey("cmp_1", "brief", {}, _ctx({}))
    assert out["status"] == "unavailable"


def test_dispatch_requires_campaign():
    out = bj.build_email_journey("", "brief", {}, _ctx({"ctxToken": "tok"}))
    assert out["status"] == "needs_campaign"


def test_dispatch_requires_callback_url(monkeypatch):
    monkeypatch.delenv("CANVAS_CALLBACK_URL", raising=False)
    out = bj.build_email_journey("cmp_1", "brief", {}, _ctx({"ctxToken": "tok"}))
    assert out["status"] == "unavailable"


def test_dispatch_happy_path(monkeypatch):
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com/")
    captured = {}

    def fake_post(url, payload, token):
        captured["url"] = url
        captured["payload"] = payload
        captured["token"] = token
        return 200, json.dumps(
            {"ok": True, "journeyId": "journey_cmp_1", "status": "draft", "warnings": [], "summary": "ok"}
        )

    monkeypatch.setattr(bj, "_post_canvas", fake_post)
    out = bj.build_email_journey(
        "", "welcome", {"nodes": [], "edges": []}, _ctx({"ctxToken": "tok", "campaignId": "cmp_1"})
    )
    assert out["status"] == "success"
    assert out["journeyId"] == "journey_cmp_1"
    # campaign id falls back to session state; callback path is appended once.
    assert captured["url"] == "https://app.example.com/api/agent/canvas"
    assert captured["token"] == "tok"
    assert captured["payload"]["campaignId"] == "cmp_1"

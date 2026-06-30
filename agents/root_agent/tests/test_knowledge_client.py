"""Unit tests for the knowledge client behind the retrieve_knowledge tool.

ADK-free: the pure logic lives in tools/knowledge_client.py (retrieve_knowledge.py
is just the thin ADK-typed wrapper), and the HTTP call is monkeypatched.
"""

from __future__ import annotations

import json

from root_agent_pkg.tools import knowledge_client as kc


def test_build_request_payload_minimal():
    payload = kc.build_request_payload("cmp_1", "pricing tiers")
    assert payload == {"campaignId": "cmp_1", "query": "pricing tiers"}


def test_build_request_payload_with_limit_and_code():
    payload = kc.build_request_payload("cmp_1", "auth flow", limit=8, code=True)
    assert payload == {
        "campaignId": "cmp_1",
        "query": "auth flow",
        "limit": 8,
        "code": True,
    }


def test_parse_success_with_context():
    body = json.dumps({"context": "[Source: README]\nWe do X.", "chunks": [{}, {}]})
    out = kc.parse_knowledge_response(200, body)
    assert out["status"] == "ok"
    assert "We do X." in out["context"]
    assert out["count"] == 2


def test_parse_success_but_empty():
    out = kc.parse_knowledge_response(200, json.dumps({"context": "", "chunks": []}))
    assert out["status"] == "empty"
    assert out["context"] == ""


def test_parse_auth_unconfigured():
    out = kc.parse_knowledge_response(503, json.dumps({"error": "canvas_auth_unconfigured"}))
    assert out["status"] == "error"
    assert out["code"] == "canvas_auth_unconfigured"


def test_parse_non_json_body():
    out = kc.parse_knowledge_response(500, "<html>boom</html>")
    assert out["status"] == "error"
    assert out["code"] == "http_500"


def test_retrieve_requires_token():
    out = kc.retrieve_knowledge_via_api({}, "cmp_1", "q")
    assert out["status"] == "unavailable"


def test_retrieve_requires_campaign():
    out = kc.retrieve_knowledge_via_api({"ctxToken": "tok"}, "", "q")
    assert out["status"] == "needs_campaign"


def test_retrieve_requires_query():
    out = kc.retrieve_knowledge_via_api({"ctxToken": "tok", "campaignId": "cmp_1"}, "", "   ")
    assert out["status"] == "error"


def test_retrieve_requires_callback_url(monkeypatch):
    monkeypatch.delenv("CANVAS_CALLBACK_URL", raising=False)
    out = kc.retrieve_knowledge_via_api({"ctxToken": "tok"}, "cmp_1", "q")
    assert out["status"] == "unavailable"


def test_retrieve_happy_path(monkeypatch):
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com/")
    captured = {}

    def fake_post(url, payload, token):
        captured["url"] = url
        captured["payload"] = payload
        captured["token"] = token
        return 200, json.dumps({"context": "[Source: docs]\nGrounded.", "chunks": [{}]})

    monkeypatch.setattr(kc, "_post_knowledge", fake_post)
    # campaign id falls back to session state; the path is appended once.
    out = kc.retrieve_knowledge_via_api(
        {"ctxToken": "tok", "campaignId": "cmp_1"}, "", "what is the pricing"
    )
    assert out["status"] == "ok"
    assert captured["url"] == "https://app.example.com/api/agent/knowledge"
    assert captured["token"] == "tok"
    assert captured["payload"]["campaignId"] == "cmp_1"

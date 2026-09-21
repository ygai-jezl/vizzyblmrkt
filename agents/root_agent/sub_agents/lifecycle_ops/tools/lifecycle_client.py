"""Pure, ADK-free client logic for the Lifecycle Ops tools.

Lives apart from lifecycle_tools.py (which imports ADK's ToolContext at runtime)
so the request/response logic stays unit-testable without ADK installed. The
only side effects — the HTTP calls — are isolated in `_request` so tests can
monkeypatch it.

Every call carries the signed capability token (`ctxToken` in session state,
minted by the verified admin-chat proxy) as `X-Canvas-Context`. The Next.js app
reconstructs the tenant from that token — never from anything sent here.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request

CANVAS_PATH = "/api/agent/canvas"
CONTEXT_PATH = "/api/agent/lifecycle/context"
JOURNEY_PATH = "/api/agent/lifecycle/journeys/"
_TIMEOUT_SECONDS = 120  # drafting writes ~10 emails with the model


def _request(method: str, url: str, token: str, payload: "dict | None" = None) -> "tuple[int, str]":
    """One HTTP call to the app. Isolated so tests can monkeypatch it."""
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"X-Canvas-Context": token}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT_SECONDS) as resp:
            return resp.status, resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", errors="replace")
    except urllib.error.URLError as exc:
        return 0, json.dumps({"error": "network_error", "detail": str(exc.reason)})


def _base_and_token(state: "dict | None") -> "tuple[str, str] | dict":
    token = (state or {}).get("ctxToken")
    if not token:
        return {"status": "unavailable", "message": "Journey authoring isn't available in this session yet."}
    base = os.environ.get("CANVAS_CALLBACK_URL", "").rstrip("/")
    if not base:
        return {"status": "unavailable", "message": "Journey authoring isn't configured (no callback URL)."}
    return base, token


def _json(body_text: str) -> dict:
    try:
        body = json.loads(body_text) if body_text else {}
    except (json.JSONDecodeError, ValueError):
        body = {}
    return body if isinstance(body, dict) else {}


_ERRORS = {
    "unavailable": "Building lifecycle journeys from chat isn't switched on in this environment.",
    "connection_not_found": "I couldn't find that connected product in this account.",
    "journey_not_found": "I couldn't find that journey (or it belongs to a different product).",
    "rate_limited": "I've drafted a lot of journeys in the last hour — please try again a bit later.",
    "invalid_options": "Some of the options weren't valid",
    "invalid_input": "The request was missing something",
    "canvas_auth_unconfigured": "Journey authoring isn't enabled in this environment yet.",
    "unauthorized": "My session to the app expired — please send your message again.",
}


def error_result(status_code: int, body: dict) -> dict:
    code = body.get("error") or f"http_{status_code}"
    issues = body.get("issues") or []
    base = _ERRORS.get(code, "I couldn't do that just now. Please try again.")
    if code == "invalid_graph":
        base = "The journey structure was invalid"
    detail = "; ".join(str(i) for i in issues[:8])
    return {
        "status": "error",
        "code": code,
        "issues": issues[:20],
        "message": f"{base}: {detail}" if detail else base,
    }


def parse_author_response(status_code: int, body_text: str) -> dict:
    """Normalise the canvas endpoint's answer into a tool result (the card rides along)."""
    body = _json(body_text)
    if 200 <= status_code < 300 and body.get("ok"):
        return {
            "status": "success",
            "journeyId": body.get("id") or body.get("journeyId"),
            "journeyStatus": body.get("status"),
            "url": body.get("url"),
            "warnings": body.get("warnings", []),
            "card": body.get("card"),
            "message": body.get("summary") or "Saved the journey as a draft.",
        }
    return error_result(status_code, body)


def build_template_payload(connection_id: str, journey_id: "str | None", template: str, options: "dict | None", brief: str, name: "str | None") -> dict:
    payload: dict = {
        "kind": "lifecycle",
        "action": "save_draft",
        "mode": "template",
        "template": template or "product_onboarding",
        "scope": {"connectionId": connection_id, "journeyId": journey_id or None},
        "options": options or {},
        "brief": brief or "",
    }
    if name:
        payload["name"] = name
    return payload


def build_graph_payload(connection_id: str, journey_id: "str | None", graph: dict, pools: "list | None", settings: "dict | None", brief: str, name: "str | None") -> dict:
    payload: dict = {
        "kind": "lifecycle",
        "action": "save_draft",
        "mode": "graph",
        "scope": {"connectionId": connection_id, "journeyId": journey_id or None},
        "graph": graph or {"nodes": [], "edges": []},
        "brief": brief or "",
    }
    if pools is not None:
        payload["pools"] = pools
    if settings is not None:
        payload["settings"] = settings
    if name:
        payload["name"] = name
    return payload


def get_context(state: "dict | None") -> dict:
    got = _base_and_token(state)
    if isinstance(got, dict):
        return got
    base, token = got
    status_code, body_text = _request("GET", base + CONTEXT_PATH, token)
    body = _json(body_text)
    if 200 <= status_code < 300:
        return {"status": "success", **body}
    return error_result(status_code, body)


def get_journey(state: "dict | None", journey_id: str) -> dict:
    resolved = journey_id or (state or {}).get("journeyId")
    if not resolved:
        return {"status": "needs_journey", "message": "Which journey should I open?"}
    got = _base_and_token(state)
    if isinstance(got, dict):
        return got
    base, token = got
    status_code, body_text = _request("GET", base + JOURNEY_PATH + urllib.parse.quote(resolved, safe=""), token)
    body = _json(body_text)
    if 200 <= status_code < 300:
        return {"status": "success", **body}
    return error_result(status_code, body)


def _resolve_connection(state: "dict | None", connection_id: str) -> "str | None":
    return connection_id or (state or {}).get("connectionId") or None


def draft_journey(state: "dict | None", connection_id: str, template: str, options: "dict | None", brief: str, name: "str | None", journey_id: "str | None") -> dict:
    connection = _resolve_connection(state, connection_id)
    if not connection:
        return {"status": "needs_connection", "message": "Which connected product is this journey for?"}
    got = _base_and_token(state)
    if isinstance(got, dict):
        return got
    base, token = got
    payload = build_template_payload(connection, journey_id, template, options, brief, name)
    status_code, body_text = _request("POST", base + CANVAS_PATH, token, payload)
    return parse_author_response(status_code, body_text)


def save_graph(state: "dict | None", connection_id: str, journey_id: "str | None", graph: dict, pools: "list | None", settings: "dict | None", brief: str, name: "str | None") -> dict:
    connection = _resolve_connection(state, connection_id)
    if not connection:
        return {"status": "needs_connection", "message": "Which connected product is this journey for?"}
    resolved_journey = journey_id or (state or {}).get("journeyId") or None
    got = _base_and_token(state)
    if isinstance(got, dict):
        return got
    base, token = got
    payload = build_graph_payload(connection, resolved_journey, graph, pools, settings, brief, name)
    status_code, body_text = _request("POST", base + CANVAS_PATH, token, payload)
    return parse_author_response(status_code, body_text)

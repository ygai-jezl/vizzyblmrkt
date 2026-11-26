"""Pure, ADK-free client logic for Lifecycle Ops' get_raise_pipeline tool.

Lives apart from its wrapper (raise_pipeline.py, which imports ADK's ToolContext at runtime) so
the request and response logic stays unit-testable without ADK. The only side effect, the HTTP
call, is isolated in `_get` so tests can monkeypatch it.

The call carries the signed capability token (`ctxToken` in session state) as `X-Canvas-Context`
and nothing else: the app takes the brand and the member from that token. The answer is counts
only (people by stage, why the ones in Passed passed, how many are quiet or past their next step
date), each number with its meaning, and never a name, an address, a firm or a value.
`raisePipelineEnabled` is written on every answer that shows whether the board is switched on.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

PIPELINE_PATH = "/api/agent/raise/pipeline"
_TIMEOUT_SECONDS = 30

_ERRORS = {
    "unavailable": "The investor and funding board isn't switched on in this environment.",
    "canvas_auth_unconfigured": "Reading the board from chat isn't enabled in this environment yet.",
    "unauthorized": "My session to the app expired. Please send your message again.",
    "rate_limited": "I've read the board a lot in the last hour. Please try again a bit later.",
}


def _get(url: str, token: str) -> "tuple[int, str]":
    """One GET to the app, with no body. Isolated so tests can monkeypatch it."""
    req = urllib.request.Request(url, method="GET", headers={"X-Canvas-Context": token})
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT_SECONDS) as resp:
            return resp.status, resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", errors="replace")
    except urllib.error.URLError as exc:
        return 0, json.dumps({"error": "network_error", "detail": str(exc.reason)})


def _json(body_text: str) -> dict:
    try:
        body = json.loads(body_text) if body_text else {}
    except (json.JSONDecodeError, ValueError):
        body = {}
    return body if isinstance(body, dict) else {}


def parse_pipeline_response(state: "dict | None", status_code: int, body_text: str) -> dict:
    """The app's answer as a tool result, with the switch's state written for the instruction."""
    body = _json(body_text)
    if 200 <= status_code < 300:
        if state is not None:
            state["raisePipelineEnabled"] = True
        return {**body, "status": "success"}
    code = body.get("error") or f"http_{status_code}"
    if state is not None and code == "unavailable":
        state["raisePipelineEnabled"] = False
    return {"status": "error", "code": code, "message": _ERRORS.get(code, "I couldn't read the board just now. Please try again.")}


def get_raise_pipeline(state: "dict | None") -> dict:
    """The brand's investor or funding board as counts. Never raises."""
    token = (state or {}).get("ctxToken")
    if not token:
        return {"status": "unavailable", "message": "Reading the board isn't available in this session yet."}
    base = os.environ.get("CANVAS_CALLBACK_URL", "").rstrip("/")
    if not base:
        return {"status": "unavailable", "message": "Reading the board isn't configured (no callback URL)."}
    status_code, body_text = _get(base + PIPELINE_PATH, token)
    return parse_pipeline_response(state, status_code, body_text)

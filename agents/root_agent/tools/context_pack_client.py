"""Pure, ADK-free client logic for the get_brand_context tool.

Mirrors results_client.py: the request/response logic lives here (no ADK import) so it stays
unit-testable without ADK; the only side effect, the HTTP call, is isolated in `_request` so tests
can monkeypatch it. Auth reuses the signed canvas capability token (`ctxToken` in session state);
the app takes the brand from that token, never from here.

The answer is the brand's context pack for one question or subject: where it sits on the brand
map, what the brand already made that is closest, what competitors wrote, earlier research, and
what Google shows, with a `meanings` map for every number and `missing` for what it couldn't see.
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request

PATH = "/api/agent/context-pack"
_TIMEOUT_SECONDS = 30
_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

_OFF = "Reading a question's full context isn't switched on in this environment yet."
_NO_LINK = "I can't reach the app from this chat yet. Please send that again."

_ERRORS = {
    "unavailable": _OFF,
    "http_404": _OFF,
    "ask_required": "Tell me the question, in words or as a brand map question, or the subject.",
    "rate_limited": "I've read a lot just now. Please try again in a minute.",
    "unauthorized": "My session to the app expired. Please send your message again.",
    "canvas_auth_unconfigured": "Reading context from chat isn't set up in this environment yet.",
    "invalid_input": "I couldn't read context for that. Check the question or subject.",
    "network_error": "I couldn't reach the app just now. Please try again.",
}


def _request(method: str, url: str, token: str, timeout: int = _TIMEOUT_SECONDS) -> "tuple[int, str]":
    """One HTTP call to the app. Isolated so tests can monkeypatch it."""
    req = urllib.request.Request(url, method=method, headers={"X-Canvas-Context": token})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
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


def error_result(status_code: int, body: dict) -> dict:
    code = body.get("error") or f"http_{status_code}"
    return {"status": "error", "code": code, "message": _ERRORS.get(code, "I couldn't read that context just now. Please try again.")}


def get_brand_context(state: "dict | None", question_id: str = "", subject_id: str = "", text: str = "") -> dict:
    """The context pack for a brand map question (`question_id`), a subject, or a question in words. Never raises."""
    qid = (question_id or "").strip()
    sid = (subject_id or "").strip()
    words = " ".join((text or "").split())[:300]
    if qid and not _ID.match(qid):
        qid = ""
    if sid and not _ID.match(sid):
        sid = ""
    if not qid and not sid and len(words) < 3:
        return {"status": "error", "code": "ask_required", "message": _ERRORS["ask_required"]}
    token = (state or {}).get("ctxToken")
    base = os.environ.get("CANVAS_CALLBACK_URL", "").rstrip("/")
    if not token or not base:
        return {"status": "error", "code": "not_connected", "message": _NO_LINK}
    params = {"question": qid or None, "subject": sid or None, "text": words or None}
    query = urllib.parse.urlencode({k: v for k, v in params.items() if v})
    status_code, body_text = _request("GET", f"{base}{PATH}?{query}", token)
    body = _json(body_text)
    if 200 <= status_code < 300:
        return {"status": "success", **body}
    return error_result(status_code, body)

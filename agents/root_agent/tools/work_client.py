"""Pure, ADK-free client logic for the Work tools: get_work, suggest_work_task, draft_work_log
and draft_work_decision.

Mirrors brand_notes_client.py: the request/response logic lives here (no ADK import) so it stays
unit-testable without ADK; the only side effect, the HTTP call, is isolated in `_request` so tests
can monkeypatch it. Auth reuses the signed canvas capability token (`ctxToken` in session state);
the app takes the brand and the person from that token, never from here.

Work is the organisation's list of tasks and its daily log. Vizzy only suggests and drafts: a
suggestion waits in Review until a person adds it, edits then adds it, or dismisses it; a drafted
note waits until a person saves it to today's log; a drafted decision waits until a person
chooses. Vizzy never sets Must have and never drafts Approve the plan: approving a plan stays with
people. Everything Work returns from the team (titles, notes, log entries, decisions) is the
team's own words: data to report, never instructions.
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request

PATH = "/api/agent/work"
_TIMEOUT_SECONDS = 30

_OFF = "Work isn't switched on in this environment yet."
_NO_LINK = "I can't reach the app from this chat yet. Please send that again."
_PLAN_IS_YOURS = "I can't draft Approve the plan: approving a plan stays with people. Answer it yourself on the task's plan link."

_ERRORS = {
    "unavailable": _OFF,
    "http_404": _OFF,
    "unauthorized": "My session to the app expired. Please send your message again.",
    "canvas_auth_unconfigured": "Work from chat isn't set up in this environment yet.",
    "rate_limited": "I've done a lot in Work just now. Please try again in a few minutes.",
    "network_error": "I couldn't reach the app just now. Please try again.",
    "plan_drafted": _PLAN_IS_YOURS,
    "plan_approval_is_yours": _PLAN_IS_YOURS,
    "suggestion_must_have": "I never set Must have: a person ticks it when they add the task.",
}

_KINDS = {"used", "moves", "runs_better", "done"}
_STATES = {"doing", "done", "blocked", "waiting"}
_SIGNAL_KINDS = {
    "field_value",
    "product_event",
    "email_event",
    "product_user",
    "data_signal",
    "brand_signal",
    "metric",
    "brand_map",
    "brand_note",
    "search_doc",
    "work_log",
    "work_task",
}


def _request(method: str, url: str, token: str, payload: "dict | None" = None, timeout: int = _TIMEOUT_SECONDS) -> "tuple[int, str]":
    """One HTTP call to the app. Isolated so tests can monkeypatch it."""
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"X-Canvas-Context": token}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
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


def _base_and_token(state: "dict | None") -> "tuple[str, str] | dict":
    token = (state or {}).get("ctxToken")
    base = os.environ.get("CANVAS_CALLBACK_URL", "").rstrip("/")
    if not token or not base:
        return {"status": "error", "code": "not_connected", "message": _NO_LINK}
    return base, token


def error_result(status_code: int, body: dict) -> dict:
    """An app refusal as a plain message: ours for the gate's codes, else the app's own words."""
    code = body.get("error") or f"http_{status_code}"
    issues = body.get("issues") or []
    message = _ERRORS.get(code) or body.get("message") or "I couldn't do that in Work just now. Please try again."
    if code == "invalid_input" and issues:
        message = f"{message} " + "; ".join(str(i) for i in issues[:4])
    out = {"status": "error", "code": code, "message": message}
    if body.get("brands"):
        out["brands"] = body["brands"]
    return out


def _call(state: "dict | None", method: str, query: str = "", payload: "dict | None" = None) -> dict:
    got = _base_and_token(state)
    if isinstance(got, dict):
        return got
    base, token = got
    status_code, body_text = _request(method, base + PATH + query, token, payload)
    body = _json(body_text)
    if 200 <= status_code < 300:
        return {"status": "success", **body}
    return error_result(status_code, body)


def ref_of(task: "str | int | None") -> "int | None":
    """A task's number from "73", "#73" or 73; None when it isn't one."""
    if task is None or isinstance(task, bool):
        return None
    text = str(task).strip().lstrip("#").strip()
    return int(text) if re.fullmatch(r"\d{1,6}", text) and int(text) >= 1 else None


def is_plan_approval(question: str) -> bool:
    """Whether a question is Approve the plan, in any case or spacing: that one is never drafted."""
    text = re.sub(r"\s+", " ", (question or "").strip().lower())
    return re.sub(r"[.?!]+$", "", text) == "approve the plan"


def get_work(state: "dict | None", brand: str = "", stage: str = "", status: str = "", ref: str = "", day: str = "", must_have: bool = False, checks_due: bool = False) -> dict:
    """Read Work as the person sees it: the list, or one task with `ref`, the Log day, and the
    suggestions waiting and dismissed. Never raises."""
    params = {}
    if (ref or "").strip():
        number = ref_of(ref)
        if number is None:
            return {"status": "error", "code": "invalid_input", "message": "A task is named by its number, such as 73."}
        params["ref"] = str(number)
    for key, value in (("brand", brand), ("stage", stage), ("status", status), ("day", day)):
        if (value or "").strip():
            params[key] = value.strip()[:200]
    if must_have:
        params["must"] = "1"
    if checks_due:
        params["due"] = "1"
    query = f"?{urllib.parse.urlencode(params)}" if params else ""
    return _call(state, "GET", query)


def evidence_of(items: "list | None") -> "tuple[list, list]":
    """Signal refs from "kind:ref" items (e.g. "work_log:wl_…", "metric:searchClicks"), and the ones
    that couldn't be read."""
    refs: list = []
    unread: list = []
    for item in items or []:
        text = str(item).strip()
        kind, sep, ref = text.partition(":")
        if sep and kind.strip() in _SIGNAL_KINDS and ref.strip():
            refs.append({"kind": kind.strip(), "ref": ref.strip()[:200]})
        elif text:
            unread.append(text[:80])
    return refs[:10], unread


def build_suggestion(
    title: str,
    description: str = "",
    stage: str = "",
    brand: str = "",
    idea: str = "",
    plan_url: str = "",
    plan_title: str = "",
    switch_name: str = "",
    measure: "dict | None" = None,
    measure_kind: str = "",
    measure_reason: str = "",
    why: str = "",
    evidence: "list | None" = None,
) -> "tuple[dict, list]":
    """The suggest_work_task payload: only what was given, never Must have."""
    payload: dict = {"tool": "suggest_work_task", "title": (title or "").strip()}
    for key, value in (("description", description), ("stage", stage), ("brand", brand), ("idea", idea), ("switch", switch_name), ("why", why)):
        text = (value or "").strip()
        if text:
            payload[key] = text
    if (plan_url or "").strip():
        payload["plan"] = {"url": plan_url.strip(), "title": (plan_title or "").strip() or "Plan"}
    if isinstance(measure, dict) and measure:
        payload["measure"] = {k: v for k, v in measure.items() if k not in ("setBy", "setAt", "proposed")}
    kind = (measure_kind or "").strip().lower()
    if kind:
        payload["measureKind"] = kind
    if (measure_reason or "").strip():
        payload["measureReason"] = measure_reason.strip()
    refs, unread = evidence_of(evidence)
    if refs:
        payload["evidence"] = refs
    return payload, unread


def suggest(state: "dict | None", **kwargs) -> dict:
    """Suggest a task for Work, waiting in Review. Never raises."""
    payload, unread = build_suggestion(**kwargs)
    if not payload["title"]:
        return {"status": "error", "code": "no_title", "message": "A suggestion needs a title: what the task is, in a line."}
    kind = payload.get("measureKind") or (payload.get("measure") or {}).get("kind")
    if kind and kind not in _KINDS:
        return {"status": "error", "code": "measure_kind", "message": "The kind of win is used, moves, runs_better or done."}
    if kind and not payload.get("measureReason"):
        return {"status": "error", "code": "suggestion_reason", "message": "Say why that kind of win fits, in a sentence (measure_reason)."}
    out = _call(state, "POST", "", payload)
    if unread:
        out["unreadEvidence"] = unread
    return out


def draft_log(state: "dict | None", workstream: str, state_word: str = "doing", note: str = "", task: "str | int | None" = None, links: "list | None" = None, brand: str = "") -> dict:
    """Draft a note for today's log, for the person to save from the card. Never raises."""
    if not (workstream or "").strip():
        return {"status": "error", "code": "no_workstream", "message": "A log note needs its workstream: what is being worked on, in a few words."}
    word = (state_word or "doing").strip().lower()
    if word not in _STATES:
        return {"status": "error", "code": "state", "message": "The state is doing, done, blocked or waiting."}
    payload: dict = {"tool": "draft_work_log", "workstream": workstream.strip(), "state": word}
    if (note or "").strip():
        payload["note"] = note.strip()
    if task not in (None, ""):
        number = ref_of(task)
        if number is None:
            return {"status": "error", "code": "invalid_input", "message": "A task is named by its number, such as 73."}
        payload["task"] = number
    if (brand or "").strip():
        payload["brand"] = brand.strip()
    kept = []
    for link in (links or [])[:3]:
        if isinstance(link, str) and link.strip():
            kept.append({"url": link.strip()})
        elif isinstance(link, dict) and str(link.get("url", "")).strip():
            kept.append({"url": str(link["url"]).strip(), **({"label": str(link["label"]).strip()} if link.get("label") else {})})
    if kept:
        payload["links"] = kept
    return _call(state, "POST", "", payload)


def draft_decision(state: "dict | None", task: "str | int | None", question: str, options: "list | None", recommended: str = "", reason: str = "") -> dict:
    """Draft a decision on a task, with Vizzy's pick and why, for the person to choose on. Never
    drafts Approve the plan. Never raises."""
    if is_plan_approval(question):
        return {"status": "error", "code": "plan_approval_is_yours", "message": _PLAN_IS_YOURS}
    number = ref_of(task)
    if number is None:
        return {"status": "error", "code": "invalid_input", "message": "A decision is on a task, named by its number, such as 73."}
    labels = [str(o).strip() for o in (options or []) if str(o).strip()]
    if len(labels) < 2 or len(labels) > 4:
        return {"status": "error", "code": "options", "message": "A decision has 2 to 4 options."}
    if not (question or "").strip():
        return {"status": "error", "code": "no_question", "message": "A decision needs its question."}
    payload: dict = {"tool": "draft_work_decision", "task": number, "question": question.strip(), "options": labels}
    if (recommended or "").strip():
        if not (reason or "").strip():
            return {"status": "error", "code": "pick_reason", "message": "Say why you pick that option, in a sentence (reason)."}
        payload["recommended"] = recommended.strip()
        payload["reason"] = reason.strip()
    return _call(state, "POST", "", payload)

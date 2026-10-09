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
CONNECTIONS_PATH = "/api/agent/lifecycle/connections/"
PEOPLE_PATH = "/api/agent/lifecycle/people/"
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
    "after_journey_not_found": "I couldn't find the journey this one should continue from on this product (or the two would lead back into each other)",
    "journey_links_unavailable": "Starting a journey after another one isn't switched on in this environment.",
    "rate_limited": "I've drafted a lot of journeys in the last hour — please try again a bit later.",
    "invalid_options": "Some of the options weren't valid",
    "invalid_input": "The request was missing something",
    "canvas_auth_unconfigured": "Journey authoring isn't enabled in this environment yet.",
    "unauthorized": "My session to the app expired — please send your message again.",
    "forbidden": "Only an admin of this account can start a repo analysis.",
    "invalid_repo_url": "That isn't a GitHub or GitLab repository address (e.g. github.com/your-org/your-app)",
    "analysis_in_progress": "An analysis of this product is already running — I can check on it",
    "analysis_daily_cap": "This account has reached today's limit for repo analyses",
    "job_not_configured": "Repo analysis isn't set up in this environment yet",
    "not_found": "I couldn't find that connected product in this account.",
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


def build_template_payload(
    connection_id: str,
    journey_id: "str | None",
    template: str,
    options: "dict | None",
    brief: str,
    name: "str | None",
    after_journey_id: "str | None" = None,
) -> dict:
    payload: dict = {
        "kind": "lifecycle",
        "action": "save_draft",
        "mode": "template",
        "scope": {"connectionId": connection_id, "journeyId": journey_id or None},
        "options": options or {},
        "brief": brief or "",
    }
    # No template named: the server picks (the follow-on sequence for a journey that
    # continues from another, else the onboarding week).
    if template or not after_journey_id:
        payload["template"] = template or "product_onboarding"
    if after_journey_id:
        payload["afterJourneyId"] = after_journey_id
    if name:
        payload["name"] = name
    return payload


def build_graph_payload(
    connection_id: str,
    journey_id: "str | None",
    graph: dict,
    pools: "list | None",
    settings: "dict | None",
    brief: str,
    name: "str | None",
    after_journey_id: "str | None" = None,
) -> dict:
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
    if after_journey_id:
        payload["afterJourneyId"] = after_journey_id
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
        # Written on every successful read (the key is absent with the flag off), so a
        # stale True can't outlive a flag-off. The instruction builder reads it.
        style = body.get("emailStyle")
        state["emailStyleConfigured"] = isinstance(style, dict) and bool(style.get("configured"))
        # Likewise whether a journey can wear its own look (the key is sent only with journey
        # styles on), so the journey style rule comes and goes with the flag.
        journey_style = body.get("journeyStyle")
        state["journeyStyleEnabled"] = isinstance(journey_style, dict) and bool(journey_style.get("enabled"))
        # And whether a journey can continue from another (sent only with journey links on),
        # so that rule comes and goes with the flag too.
        journey_links = body.get("journeyLinks")
        state["journeyLinksEnabled"] = isinstance(journey_links, dict) and bool(journey_links.get("enabled"))
        # And whether a fact can be a date, and a journey can start when one passes (each
        # sent only with its flag on).
        date_facts = body.get("dateFacts")
        state["dateFactsEnabled"] = isinstance(date_facts, dict) and bool(date_facts.get("enabled"))
        date_start = body.get("dateStart")
        state["dateStartEnabled"] = isinstance(date_start, dict) and bool(date_start.get("enabled"))
        # And whether one person's situation can be read (sent only with that on), so its
        # rules come and go with the flag.
        person_brief = body.get("personBrief")
        state["personBriefEnabled"] = isinstance(person_brief, dict) and bool(person_brief.get("enabled"))
        return {"status": "success", **body}
    return error_result(status_code, body)


_PERSON_ERRORS = {
    "person_brief_unavailable": "Looking at one person isn't switched on in this environment.",
    "unavailable": "Looking at one person isn't switched on in this environment.",
    "person_not_found": "I couldn't find that person in this account.",
    "person_erased": "That person has been erased, so there's nothing I can read about them.",
    "rate_limited": "I've looked at a lot of people in the last hour — please try again a bit later.",
}


def get_person(state: "dict | None", person_id: str) -> dict:
    """One person's situation (no name, address or product id): the person asked for, else the one in view."""
    resolved = (person_id or "").strip() or (state or {}).get("personId")
    if not resolved:
        return {
            "status": "needs_person",
            "message": "Open the person's page (Audience › Product users, then their row) and ask me there — I can only look at the person in view.",
        }
    got = _base_and_token(state)
    if isinstance(got, dict):
        return got
    base, token = got
    status_code, body_text = _request("GET", base + PEOPLE_PATH + urllib.parse.quote(str(resolved), safe=""), token)
    body = _json(body_text)
    if 200 <= status_code < 300 and isinstance(body.get("brief"), dict):
        # A successful read proves the flag is on, whether or not the context was read first.
        state["personBriefEnabled"] = True
        return {"status": "success", "brief": body["brief"]}
    code = body.get("error") or f"http_{status_code}"
    if code in _PERSON_ERRORS:
        return {"status": "error", "code": code, "message": _PERSON_ERRORS[code]}
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


def draft_journey(
    state: "dict | None",
    connection_id: str,
    template: str,
    options: "dict | None",
    brief: str,
    name: "str | None",
    journey_id: "str | None",
    after_journey_id: "str | None" = None,
) -> dict:
    connection = _resolve_connection(state, connection_id)
    if not connection:
        return {"status": "needs_connection", "message": "Which connected product is this journey for?"}
    got = _base_and_token(state)
    if isinstance(got, dict):
        return got
    base, token = got
    payload = build_template_payload(connection, journey_id, template, options, brief, name, after_journey_id)
    status_code, body_text = _request("POST", base + CANVAS_PATH, token, payload)
    return parse_author_response(status_code, body_text)


def save_graph(
    state: "dict | None",
    connection_id: str,
    journey_id: "str | None",
    graph: dict,
    pools: "list | None",
    settings: "dict | None",
    brief: str,
    name: "str | None",
    after_journey_id: "str | None" = None,
    new_journey: bool = False,
) -> dict:
    connection = _resolve_connection(state, connection_id)
    if not connection:
        return {"status": "needs_connection", "message": "Which connected product is this journey for?"}
    # A new journey never falls back to the page's journey: that would replace its draft.
    resolved_journey = None if new_journey else (journey_id or (state or {}).get("journeyId") or None)
    got = _base_and_token(state)
    if isinstance(got, dict):
        return got
    base, token = got
    payload = build_graph_payload(connection, resolved_journey, graph, pools, settings, brief, name, after_journey_id)
    status_code, body_text = _request("POST", base + CANVAS_PATH, token, payload)
    return parse_author_response(status_code, body_text)


def _connection_or_ask(state: "dict | None", connection_id: str) -> "str | dict":
    connection = _resolve_connection(state, connection_id)
    if not connection:
        return {"status": "needs_connection", "message": "Which connected product should I look at?"}
    return connection


def build_learn_payload(repos: "list | None", branch: "str | None") -> dict:
    """[{"url", "ref"?}] from repo URLs (strings or dicts); a shared branch applies to all."""
    out = []
    for r in (repos or [])[:3]:
        if isinstance(r, str):
            url, ref = r, None
        elif isinstance(r, dict):
            url, ref = str(r.get("url") or ""), r.get("ref")
        else:
            continue
        if url.strip():
            out.append({"url": url.strip(), "ref": ref or branch or None})
    return {"repos": out}


def learn_from_repo(state: "dict | None", connection_id: str, repos: "list | None", branch: "str | None") -> dict:
    connection = _connection_or_ask(state, connection_id)
    if isinstance(connection, dict):
        return connection
    payload = build_learn_payload(repos, branch)
    if not payload["repos"]:
        return {"status": "needs_repo", "message": "Which repository should I read? (e.g. github.com/your-org/your-app)"}
    got = _base_and_token(state)
    if isinstance(got, dict):
        return got
    base, token = got
    url = base + CONNECTIONS_PATH + urllib.parse.quote(connection, safe="") + "/learn"
    status_code, body_text = _request("POST", url, token, payload)
    body = _json(body_text)
    if 200 <= status_code < 300:
        return {
            "status": "started",
            "analysis": body.get("analysis"),
            "message": "Started reading the code (read-only). It usually takes a few minutes; I can check on it, and the results are reviewed on the product's Learn from repo tab.",
        }
    return error_result(status_code, body)


def get_repo_analysis(state: "dict | None", connection_id: str) -> dict:
    connection = _connection_or_ask(state, connection_id)
    if isinstance(connection, dict):
        return connection
    got = _base_and_token(state)
    if isinstance(got, dict):
        return got
    base, token = got
    url = base + CONNECTIONS_PATH + urllib.parse.quote(connection, safe="") + "/learn"
    status_code, body_text = _request("GET", url, token)
    body = _json(body_text)
    if 200 <= status_code < 300:
        return {"status": "success", **body}
    return error_result(status_code, body)


# `adk deploy agent_engine` agents 404 on `:streamQuery` via the `/v1/` REST path (only `/v1beta1/` serves); a benign `Regional Access Boundary 401` startup log misleads diagnosis

> Field report for google/adk-python (relates to #5753). Two pieces of feedback:
> (1) a docs/REST trap that cost hours, and (2) a misleading startup log. Project/org
> numbers can be redacted for a public post.

## TL;DR (what actually happened)
A minimal ADK 2.2 agent deployed via `adk deploy agent_engine` reported success and the
container was healthy, but **every REST `:streamQuery` / `:query` call returned an HTML
404 at the gateway** — for ~70+ minutes, across both `AGENT_IDENTITY` and
`SERVICE_ACCOUNT` identities. We wrongly concluded the agent "wasn't serving."

**Root cause:** the REST `:streamQuery` / `:query` methods for these engines serve **only
on the `v1beta1` endpoint, not `v1`**. The Agent Platform **SDK uses `v1beta1`** and works
perfectly; the **official REST docs show `/v1/...:streamQuery`**, which 404s. Switching the
caller (a Next.js proxy) from `/v1/` to `/v1beta1/` fixed it instantly — the agent returns
`200` and streams correctly under **both** identity types.

**Contributing red herring:** at startup the container logs a non-retryable
`Regional Access Boundary HTTP request failed after retries … 401 UNAUTHENTICATED`. This
log appears even when the engine serves fine (confirmed: same engine returns `200` on
`v1beta1`). It strongly implies an identity/serving failure and sent us down a multi-hour
dead end (Auth Manager Preview enrollment, identity_type changes, etc.).

## Environment
- **ADK**: `google-adk[a2a]==2.2.0` (local + container); `a2a-sdk 0.3.26`; Python 3.11 (container)
- **Deploy**: `adk deploy agent_engine` (no SDK), Agent Runtime / reasoningEngines, `us-central1`
- **Project**: `vizzybl-marketing-dev` (number `647082740268`), org `896620783496`
- **Agent**: minimal `LlmAgent` (gemini-3.5-flash, two before_model_callbacks, no tools)

## Reproduction
1. `adk deploy agent_engine --project=… --region=us-central1 --display_name=… .`
   → `Deployed: …/reasoningEngines/<ID>`; container logs show healthy uvicorn + the RAB 401.
2. Call REST `:streamQuery` on **`/v1/`** with a valid bearer token (cloud-platform scope):
   ```
   POST https://us-central1-aiplatform.googleapis.com/v1/projects/<PROJ>/locations/us-central1/reasoningEngines/<ID>:streamQuery?alt=sse
   {"class_method":"async_stream_query","input":{"user_id":"u","message":"hi"}}
   → HTTP 404 (text/html: "The requested URL … was not found on this server.")
   ```
   Same on `:query`, same on `v1`+`async_create_session`. `GET …/reasoningEngines/<ID>` (v1beta1) returns `200`.
3. Call the **identical** request on **`/v1beta1/`**:
   ```
   POST https://us-central1-aiplatform.googleapis.com/v1beta1/…/reasoningEngines/<ID>:streamQuery?alt=sse
   → HTTP 200; streams: {"content":{"parts":[{"text":"…"}],"role":"model"},"finish_reason":"STOP", …}
   ```
   The Agent Platform Python SDK (`client.agent_engines.get(...).stream_query(...)`) also calls
   `v1beta1` and works — its httpx debug log shows `POST …/v1beta1/…:streamQuery?alt=sse 200`.
4. Both `identity_type: AGENT_IDENTITY` and `identity_type: SERVICE_ACCOUNT` engines return
   `200` on `v1beta1` (the RAB 401 log appears for AGENT_IDENTITY but does **not** block serving).

## Asks for the team
1. **Make REST `:streamQuery`/`:query` work on `/v1/`, or fix the docs.** The public REST docs
   (`…/scale/runtime/use-an-adk-agent`, `…/reference/rest/v1/…reasoningEngines/streamQuery`)
   show `/v1/…:streamQuery`, but `adk deploy agent_engine` engines only answer on `/v1beta1/`.
   A gateway **404 (HTML)** for a valid resource+method is the maximally-confusing failure —
   please return a JSON error that names the wrong API version, or route `/v1/` correctly.
2. **Demote/clarify the `Regional Access Boundary … 401 UNAUTHENTICATED` startup log.** It is
   emitted on healthy, fully-serving engines and reads as a fatal identity failure. Either
   suppress it when serving is unaffected, or label it clearly as non-fatal.
3. Consider surfacing, in `adk deploy` output, the exact working invocation URL (version +
   path) for the engine it just created.

## Resolution (our side)
Point the caller at `v1beta1`. No identity change required (both work). We kept
`SERVICE_ACCOUNT` (dedicated per-agent SA) per our own least-privilege policy, but
`AGENT_IDENTITY` served equally well once the endpoint version was corrected.

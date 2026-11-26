import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import type { ApiResult } from "./api";
import { connectionView } from "./testing";
import { connectWithToken, type ApiCall } from "./tokenConnect";
import { CONNECTED_COPY, LISTING_COPY, grantsLostWords } from "./words";

type Answer = ApiResult<unknown>;
const OK = (data: unknown = {}): Answer => ({ ok: true, data });
const NO = (status: number, message: string): Answer => ({ ok: false, status, error: "x", message });

/** A made-up route table: each call takes the next answer for its method, and is recorded. */
function fakeCall(answers: Partial<Record<"DELETE" | "POST" | "PUT", Answer>>) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const call = (async (url: string, init: { method?: string; body?: unknown } = {}) => {
    const method = (init.method ?? "GET") as "DELETE" | "POST" | "PUT";
    calls.push({ method, url, ...(init.body !== undefined ? { body: init.body } : {}) });
    return answers[method] ?? OK();
  }) as ApiCall;
  return { call, calls };
}

const FIELDS = { zoneId: "0123456789abcdef0123456789abcdef", token: "made-up-token" };
const NEW = connectionView({ id: "dcn_nnnnnnnnnnnnnnnnnnnn" });
const BOTH = [
  { to: "members" as const, can: "read" as const },
  { to: "agent:vizzy" as const, can: "read" as const },
];
const OLD = connectionView({ health: { state: "broken", lastOkAt: null, lastCheckedAt: null, message: "x", pausedUntil: null }, details: { grants: BOTH } });

describe("connecting with a token", () => {
  it("names the connection by the zone picked after Check, within the route's 60 characters", async () => {
    const { call, calls } = fakeCall({ POST: OK(NEW) });
    expect(await connectWithToken("cloudflare", FIELDS, null, true, call, " acme.example ")).toEqual({ kind: "connected" });
    expect(calls).toEqual([{ method: "POST", url: "/api/admin/connectors/cloudflare/connect", body: { fields: FIELDS, label: "acme.example" } }]);
    const long = fakeCall({ POST: OK(NEW) });
    await connectWithToken("cloudflare", FIELDS, null, true, long.call, `${"a".repeat(70)}.example`);
    expect((long.calls[0]!.body as { label: string }).label).toHaveLength(60);
  });

  it("a first connection posts the fields and nothing else", async () => {
    const { call, calls } = fakeCall({ POST: OK(NEW) });
    expect(await connectWithToken("cloudflare", FIELDS, null, true, call)).toEqual({ kind: "connected" });
    expect(calls.map((c) => c.method)).toEqual(["POST"]);
    expect(calls[0]).toEqual({ method: "POST", url: "/api/admin/connectors/cloudflare/connect", body: { fields: FIELDS } });
  });

  it("a Reconnect disconnects the old one, connects, then gives the new one the old one's grants", async () => {
    const { call, calls } = fakeCall({ POST: OK(NEW) });
    expect(await connectWithToken("cloudflare", FIELDS, OLD, true, call)).toEqual({ kind: "connected" });
    expect(calls).toEqual([
      { method: "DELETE", url: `/api/admin/connectors/connections/${OLD.id}` },
      { method: "POST", url: "/api/admin/connectors/cloudflare/connect", body: { fields: FIELDS } },
      { method: "PUT", url: `/api/admin/connectors/connections/${NEW.id}/grants`, body: { grants: BOTH } },
    ]);
  });

  it("goes on when the old one is gone already, and stops when the disconnect is refused", async () => {
    expect((await connectWithToken("cloudflare", FIELDS, OLD, true, fakeCall({ DELETE: NO(404, "gone"), POST: OK(NEW) }).call)).kind).toBe("connected");
    const refused = fakeCall({ DELETE: NO(403, "Only admins can do this. Ask an admin on your team.") });
    expect(await connectWithToken("cloudflare", FIELDS, OLD, true, refused.call)).toEqual({ kind: "refused", message: "Only admins can do this. Ask an admin on your team." });
    expect(refused.calls.map((c) => c.method)).toEqual(["DELETE"]);
  });

  it("when the new token is turned down after the disconnect, says so and that trying again here keeps who can read it", async () => {
    const { call, calls } = fakeCall({ POST: NO(502, "The provider turned the token down.") });
    expect(await connectWithToken("cloudflare", FIELDS, OLD, true, call)).toEqual({ kind: "refused", message: `The provider turned the token down. ${LISTING_COPY.tokenRetry}` });
    expect(calls.map((c) => c.method)).toEqual(["DELETE", "POST"]);
    // A first connection has nothing to keep, so the words stay the route's own.
    expect(await connectWithToken("cloudflare", FIELDS, null, true, fakeCall({ POST: NO(502, "The provider turned the token down.") }).call)).toEqual({
      kind: "refused",
      message: "The provider turned the token down.",
    });
  });

  it("when the grants don't carry over, says which boxes to tick again instead of going quiet", async () => {
    const { call } = fakeCall({ POST: OK(NEW), PUT: NO(500, "Something went wrong. Try again in a moment.") });
    expect(await connectWithToken("cloudflare", FIELDS, OLD, true, call)).toEqual({
      kind: "grantsLost",
      message: `${LISTING_COPY.grantsLost} “${CONNECTED_COPY.members}” and “${CONNECTED_COPY.vizzy}”.`,
    });
  });
});

describe("what to tick again", () => {
  it("names only the boxes Connected shows", () => {
    expect(grantsLostWords(BOTH, false)).toBe(`${LISTING_COPY.grantsLost} “${CONNECTED_COPY.members}”.`);
    expect(grantsLostWords([{ to: "agent:vizzy" }], true)).toBe(`${LISTING_COPY.grantsLost} “${CONNECTED_COPY.vizzy}”.`);
    expect(grantsLostWords([{ to: "agent:vizzy" }], false)).toBeNull();
    expect(grantsLostWords([], true)).toBeNull();
  });

  it("writes in house style", () => {
    for (const line of [LISTING_COPY.tokenReconnect, LISTING_COPY.tokenRetry, grantsLostWords(BOTH, true)!]) {
      expect(dashesIn(line), line).toEqual([]);
      expect(aiTellsIn(line), line).toEqual([]);
    }
  });
});

describe("reconnecting an MCP server's key in place (ADR-0019)", () => {
  const KEY = { apiKey: "vzbl_live_madeupkey0000000000" };
  const BROKEN = connectionView({ connectorId: "vizzybl", connectorName: "Vizzybl", health: { state: "broken", lastOkAt: null, lastCheckedAt: null, message: "x", pausedUntil: null }, details: { grants: BOTH } });

  it("asks the server to check the key against the connection and swap it, never disconnecting first", async () => {
    const { call, calls } = fakeCall({ POST: OK(BROKEN) });
    expect(await connectWithToken("vizzybl", KEY, BROKEN, true, call, undefined, true)).toEqual({ kind: "connected" });
    expect(calls).toEqual([{ method: "POST", url: "/api/admin/connectors/vizzybl/connect", body: { fields: KEY, replace: BROKEN.id } }]);
  });

  it("says why when the key is for another account, with the old connection untouched", async () => {
    const message = "Vizzybl says this key belongs to another account, so nothing was changed. Paste the key for the account this connection reads, or connect the new one as a connection of its own.";
    const { call, calls } = fakeCall({ POST: NO(409, message) });
    expect(await connectWithToken("vizzybl", KEY, BROKEN, true, call, undefined, true)).toEqual({ kind: "refused", message });
    expect(calls.map((c) => c.method)).toEqual(["POST"]);
  });

  it("words its Reconnect note in house style", () => {
    expect([...dashesIn(LISTING_COPY.keyReconnect), ...aiTellsIn(LISTING_COPY.keyReconnect)]).toEqual([]);
  });
});

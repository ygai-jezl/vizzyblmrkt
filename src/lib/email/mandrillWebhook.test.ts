import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  mandrillSignedData,
  verifyMandrillSignature,
  parseMandrillEvents,
  mapMandrillEventType,
  readEventMetadata,
} from "./mandrillWebhook";

const KEY = "test-webhook-key";
const URL = "https://yougrow.ai/api/webhooks/mandrill";

/** Form-encode a mandrill_events payload the way Mandrill POSTs it. */
function body(events: unknown): string {
  return new URLSearchParams({ mandrill_events: JSON.stringify(events) }).toString();
}

function sign(url: string, raw: string, key = KEY): string {
  return createHmac("sha1", key).update(mandrillSignedData(url, raw), "utf8").digest("base64");
}

describe("verifyMandrillSignature", () => {
  const raw = body([{ event: "open" }]);

  it("accepts a correctly signed request", () => {
    expect(verifyMandrillSignature(URL, raw, sign(URL, raw), KEY)).toBe(true);
  });

  it("rejects a wrong signature", () => {
    expect(verifyMandrillSignature(URL, raw, "not-the-sig", KEY)).toBe(false);
  });

  it("rejects when signed with a different key", () => {
    expect(verifyMandrillSignature(URL, raw, sign(URL, raw, "other"), KEY)).toBe(false);
  });

  it("rejects when the URL differs (host-header drift)", () => {
    const sig = sign("https://evil.example/webhook", raw);
    expect(verifyMandrillSignature(URL, raw, sig, KEY)).toBe(false);
  });

  it("rejects a missing signature or key", () => {
    expect(verifyMandrillSignature(URL, raw, null, KEY)).toBe(false);
    expect(verifyMandrillSignature(URL, raw, sign(URL, raw), "")).toBe(false);
  });
});

describe("parseMandrillEvents", () => {
  it("parses the batched array", () => {
    const events = [{ event: "open" }, { event: "click", url: "https://x" }];
    expect(parseMandrillEvents(body(events))).toHaveLength(2);
  });

  it("returns [] for missing or malformed payloads", () => {
    expect(parseMandrillEvents("")).toEqual([]);
    expect(parseMandrillEvents("mandrill_events=not-json")).toEqual([]);
    expect(parseMandrillEvents(new URLSearchParams({ mandrill_events: "{}" }).toString())).toEqual([]);
  });
});

describe("mapMandrillEventType", () => {
  it("maps known events", () => {
    expect(mapMandrillEventType("open")).toBe("open");
    expect(mapMandrillEventType("click")).toBe("click");
    expect(mapMandrillEventType("send")).toBe("send");
    expect(mapMandrillEventType("hard_bounce")).toBe("bounce");
    expect(mapMandrillEventType("soft_bounce")).toBe("soft_bounce");
  });

  it("returns null for events we don't record", () => {
    expect(mapMandrillEventType("deferral")).toBeNull();
    expect(mapMandrillEventType("whatever")).toBeNull();
  });
});

describe("readEventMetadata", () => {
  const meta = {
    tenantId: "t1",
    campaignId: "c1",
    journeyId: "journey_c1",
    nodeId: "email1",
    signupId: "s1",
    variantId: "var_a",
  };

  it("reads our journey metadata", () => {
    expect(readEventMetadata({ event: "open", msg: { metadata: meta } })).toEqual(meta);
  });

  it("defaults variantId to control when absent", () => {
    const { variantId: _v, ...rest } = meta;
    const out = readEventMetadata({ event: "open", msg: { metadata: rest } });
    expect(out?.variantId).toBe("control");
  });

  it("returns null for non-journey sends (no metadata / missing keys)", () => {
    expect(readEventMetadata({ event: "open", msg: {} })).toBeNull();
    expect(readEventMetadata({ event: "open", msg: { metadata: { foo: "bar" } } })).toBeNull();
  });
});

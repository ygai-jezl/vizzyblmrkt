import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sendEmail } from "./index";

const KEYS = ["MANDRILL_API_KEY", "RESEND_API_KEY", "EMAIL_FROM"];

describe("sendEmail (provider selection)", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.unstubAllGlobals();
  });

  it("logs (no send) when no provider key is set", async () => {
    const r = await sendEmail({ to: "a@b.test", subject: "Hi", html: "<p>x</p>" });
    expect(r).toEqual({ sent: false, provider: "log" });
  });

  it("prefers Mandrill and parses its per-recipient result", async () => {
    process.env.MANDRILL_API_KEY = "md-key";
    process.env.EMAIL_FROM = "Vizzybl <noreply@vizzybl.ai>";
    const fetchMock = vi.fn(async (_url: string, _init: { body: string }) => ({
      ok: true,
      json: async () => [{ status: "sent", _id: "msg_1" }],
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const r = await sendEmail({ to: "a@b.test", subject: "Hi", html: "<p>x</p>" });
    expect(r).toEqual({ sent: true, provider: "mandrill", id: "msg_1" });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://mandrillapp.com/api/1.0/messages/send");
    const body = JSON.parse(init.body);
    expect(body.key).toBe("md-key");
    expect(body.message.from_email).toBe("noreply@vizzybl.ai");
    expect(body.message.from_name).toBe("Vizzybl");
    expect(body.message.to).toEqual([{ email: "a@b.test", type: "to" }]);
  });

  it("reports a Mandrill rejection as not-sent with the reason", async () => {
    process.env.MANDRILL_API_KEY = "md-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => [{ status: "rejected", reject_reason: "hard-bounce" }],
      })) as unknown as typeof fetch,
    );
    const r = await sendEmail({ to: "a@b.test", subject: "Hi", html: "<p>x</p>" });
    expect(r).toEqual({
      sent: false,
      provider: "mandrill",
      reason: "hard-bounce",
    });
  });
});

describe("sendEmail — delivery safety (timeouts, ambiguity, tracking, headers)", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.MANDRILL_API_KEY = "md-key";
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.unstubAllGlobals();
  });

  /** A fetch stub returning one response; records the request init. */
  function stubFetch(res: { ok: boolean; status?: number; json?: () => Promise<unknown>; text?: () => Promise<string> }) {
    const fetchMock = vi.fn(async (_url: string, _init: { body: string; signal?: AbortSignal }) => ({
      status: 200,
      json: async () => {
        throw new Error("no json");
      },
      text: async () => "",
      ...res,
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    return fetchMock;
  }

  const ok = { ok: true, json: async () => [{ status: "sent", _id: "m1" }] };

  it("bounds every Mandrill request with an abort signal", async () => {
    const fetchMock = stubFetch(ok);
    await sendEmail({ to: "a@b.test", subject: "Hi", html: "<p>x</p>" });
    expect(fetchMock.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
  });

  it("sends tracking flags explicitly, so false really turns tracking off", async () => {
    const fetchMock = stubFetch(ok);
    await sendEmail({ to: "a@b.test", subject: "Hi", html: "x", track: { opens: false, clicks: false } });
    const off = JSON.parse(fetchMock.mock.calls[0]![1].body).message;
    expect(off.track_opens).toBe(false);
    expect(off.track_clicks).toBe(false);

    await sendEmail({ to: "a@b.test", subject: "Hi", html: "x" });
    const unset = JSON.parse(fetchMock.mock.calls[1]![1].body).message;
    expect(unset).not.toHaveProperty("track_opens");
    expect(unset).not.toHaveProperty("track_clicks");
  });

  it("passes the subaccount and only well-formed extra headers", async () => {
    const fetchMock = stubFetch(ok);
    await sendEmail({
      to: "a@b.test",
      subject: "Hi",
      html: "x",
      replyTo: "jez@vizzybl.ai",
      subaccount: "ten_vzb",
      headers: {
        "Feedback-ID": "onboarding:ten_vzb:lifecycle",
        "Bad Header": "x",
        "X-Injected": "a\r\nBcc: victim@example.com",
        "Reply-To": "attacker@example.com",
      },
    });
    const message = JSON.parse(fetchMock.mock.calls[0]![1].body).message;
    expect(message.subaccount).toBe("ten_vzb");
    expect(message.headers).toEqual({
      "Feedback-ID": "onboarding:ten_vzb:lifecycle",
      "Reply-To": "jez@vizzybl.ai",
    });
  });

  it("marks a timeout as ambiguous (may have been sent; never resend)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      }) as unknown as typeof fetch,
    );
    const r = await sendEmail({ to: "a@b.test", subject: "Hi", html: "x" });
    expect(r).toEqual({ sent: false, provider: "mandrill", reason: "timeout", ambiguous: true });
  });

  it("marks a dropped connection as ambiguous", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    );
    const r = await sendEmail({ to: "a@b.test", subject: "Hi", html: "x" });
    expect(r).toMatchObject({ sent: false, reason: "request_error", ambiguous: true });
  });

  it("treats a 5xx with no readable body as ambiguous", async () => {
    stubFetch({ ok: false, status: 503, text: async () => "" });
    const r = await sendEmail({ to: "a@b.test", subject: "Hi", html: "x" });
    expect(r).toEqual({ sent: false, provider: "mandrill", reason: "http_503", ambiguous: true });
  });

  it("treats a 5xx carrying Mandrill's JSON error as a definite failure", async () => {
    stubFetch({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ status: "error", code: -1, name: "GeneralError" }),
    });
    const r = await sendEmail({ to: "a@b.test", subject: "Hi", html: "x" });
    expect(r).toEqual({ sent: false, provider: "mandrill", reason: "http_500" });
  });

  it("treats a 4xx as a definite failure", async () => {
    stubFetch({ ok: false, status: 401 });
    const r = await sendEmail({ to: "a@b.test", subject: "Hi", html: "x" });
    expect(r).toEqual({ sent: false, provider: "mandrill", reason: "http_401" });
  });

  it("treats a 2xx it can't read as ambiguous", async () => {
    stubFetch({ ok: true, json: async () => ({ unexpected: true }) });
    const r = await sendEmail({ to: "a@b.test", subject: "Hi", html: "x" });
    expect(r).toEqual({
      sent: false,
      provider: "mandrill",
      reason: "unreadable_response",
      ambiguous: true,
    });
  });

  it("marks a Resend timeout as ambiguous too", async () => {
    delete process.env.MANDRILL_API_KEY;
    process.env.RESEND_API_KEY = "re-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }) as unknown as typeof fetch,
    );
    const r = await sendEmail({ to: "a@b.test", subject: "Hi", html: "x" });
    expect(r).toEqual({ sent: false, provider: "resend", reason: "timeout", ambiguous: true });
  });
});

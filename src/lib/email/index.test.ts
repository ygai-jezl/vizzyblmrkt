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

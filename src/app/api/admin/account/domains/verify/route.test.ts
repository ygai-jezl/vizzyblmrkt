import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailSenderConfig, SenderDomain } from "@/lib/types/tenant";

// Settings › Sending › Verify: re-runs Mandrill's checks for one of this brand's domains and
// saves the result. With EMAIL_DOMAIN_RECORD_CHECKS_ENABLED it also looks up SPF and DMARC in
// DNS, so those rows get real ticks; the domain's status stays Mandrill's verdict.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);

const store = vi.hoisted(() => ({ config: { domains: [] } as EmailSenderConfig }));
vi.mock("@/lib/admin/senderConfig", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admin/senderConfig")>()),
  getSenderConfig: vi.fn(async () => store.config),
  mutateSenderConfig: vi.fn(async (_tenantId: string, mutate: (c: EmailSenderConfig) => EmailSenderConfig) => {
    store.config = mutate(store.config);
    return store.config;
  }),
}));

const provider = vi.hoisted(() => ({
  mandrillConfigured: vi.fn(() => true),
  addSendingDomain: vi.fn(),
  checkSendingDomain: vi.fn(),
  checkPublishedRecords: vi.fn(),
}));
vi.mock("@/lib/email/senderDomains", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email/senderDomains")>()),
  ...provider,
}));

const { POST } = await import("./route");
const { senderDnsRecords } = await import("@/lib/email/senderDomains");
const { mutateSenderConfig } = await import("@/lib/admin/senderConfig");

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };

/** Verified by Mandrill (ownership and DKIM), with SPF and DMARC not published yet. */
const verifiedByMandrill = {
  ok: true,
  dkimValid: true,
  spfValid: false,
  ownershipValid: true,
  verifyTxtKey: "KEY",
  status: "verified" as const,
};

function domainRow(): SenderDomain {
  return {
    domain: "mail.acme.example",
    status: "pending",
    dkimValid: false,
    spfValid: false,
    records: senderDnsRecords("mail.acme.example", "KEY"),
    addedAt: "2026-11-23T00:00:00.000Z",
    verifyTxtKey: "KEY",
  };
}

const req = (body: unknown) =>
  new Request("http://localhost/api/admin/account/domains/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** The brand's one domain, as saved. */
const saved = () => store.config.domains[0]!;
const row = (host: string) => saved().records.find((r) => r.host === host && !r.value.startsWith("mandrill_verify."))!;

beforeEach(() => {
  vi.clearAllMocks();
  store.config = { domains: [domainRow()] };
  session.getAdminContext.mockResolvedValue(admin);
  provider.mandrillConfigured.mockReturnValue(true);
  provider.checkSendingDomain.mockResolvedValue(verifiedByMandrill);
  provider.checkPublishedRecords.mockResolvedValue({ spfFound: true, dmarcFound: true });
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/admin/account/domains/verify", () => {
  it("401s signed out, before reading anything", async () => {
    session.getAdminContext.mockResolvedValue(null);
    expect((await POST(req({ domain: "mail.acme.example" }))).status).toBe(401);
    expect(provider.checkSendingDomain).not.toHaveBeenCalled();
  });

  it("400s on bad input and 404s for a domain this brand doesn't have", async () => {
    expect((await POST(req({ nope: true }))).status).toBe(400);
    expect((await POST(req({ domain: "other.example" }))).status).toBe(404);
    expect(mutateSenderConfig).not.toHaveBeenCalled();
  });

  it("switch off: no DNS lookup, DMARC left unticked, recordChecks false", async () => {
    const res = await POST(req({ domain: "mail.acme.example" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.recordChecks).toBe(false);
    expect(provider.checkPublishedRecords).not.toHaveBeenCalled();
    expect(saved().status).toBe("verified");
    expect(row("mail.acme.example").valid).toBe(false); // SPF: Mandrill's verdict only
    expect(row("_dmarc.mail.acme.example")).toEqual({
      type: "TXT",
      host: "_dmarc.mail.acme.example",
      value: "v=DMARC1; p=none;",
      valid: false,
    });
  });

  it("switch on: SPF and DMARC found in DNS are ticked and saved; status stays Mandrill's", async () => {
    vi.stubEnv("EMAIL_DOMAIN_RECORD_CHECKS_ENABLED", "true");
    const res = await POST(req({ domain: "mail.acme.example", background: true }));
    const body = await res.json();
    expect(body.recordChecks).toBe(true);
    expect(provider.checkPublishedRecords).toHaveBeenCalledWith("mail.acme.example");
    expect(saved().records.every((r) => r.valid)).toBe(true);
    expect(body.domains[0].records.every((r: { valid: boolean }) => r.valid)).toBe(true);
    expect(saved().status).toBe("verified");
  });

  it("switch on: a DMARC covered by the parent domain is ticked and says so", async () => {
    vi.stubEnv("EMAIL_DOMAIN_RECORD_CHECKS_ENABLED", "true");
    provider.checkPublishedRecords.mockResolvedValue({ spfFound: false, dmarcFound: true, dmarcFrom: "acme.example" });
    await POST(req({ domain: "mail.acme.example" }));
    expect(row("_dmarc.mail.acme.example")).toMatchObject({ valid: true, inheritedFrom: "acme.example" });
    expect(row("mail.acme.example").valid).toBe(false);
  });

  it("switch on: DNS ticks never make a domain Verified that Mandrill hasn't", async () => {
    vi.stubEnv("EMAIL_DOMAIN_RECORD_CHECKS_ENABLED", "true");
    provider.checkSendingDomain.mockResolvedValue({ ...verifiedByMandrill, dkimValid: false, status: "pending" });
    await POST(req({ domain: "mail.acme.example" }));
    expect(saved().status).toBe("pending");
  });

  it("without an email provider, returns the domain unchanged and does no DNS lookup", async () => {
    vi.stubEnv("EMAIL_DOMAIN_RECORD_CHECKS_ENABLED", "true");
    provider.mandrillConfigured.mockReturnValue(false);
    const body = await (await POST(req({ domain: "mail.acme.example" }))).json();
    expect(body).toMatchObject({ ok: false, reason: "provider_not_configured", recordChecks: true });
    expect(provider.checkPublishedRecords).not.toHaveBeenCalled();
    expect(mutateSenderConfig).not.toHaveBeenCalled();
  });
});

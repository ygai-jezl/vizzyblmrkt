import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A web source can be read as one page — only while cite sources are on.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const tenant = vi.hoisted(() => ({
  forTenant: vi.fn(),
  getTenantById: vi.fn(async () => null),
  verifyOwner: vi.fn(async () => true),
}));
vi.mock("@/lib/tenant", () => tenant);
const queue = vi.hoisted(() => ({ enqueueIngestionTicket: vi.fn() }));
vi.mock("@/lib/knowledge/tickets", () => queue);
const job = vi.hoisted(() => ({ triggerIngestionJob: vi.fn(async () => {}), isIngestionJobConfigured: vi.fn(() => true) }));
vi.mock("@/lib/knowledge/runJob", () => job);

const { POST } = await import("./route");

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const post = (body: Record<string, unknown>) =>
  POST(
    new Request("http://localhost/api/admin/knowledge/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ownerKind: "workspace", ownerId: "ws1", ...body }),
    }),
  );
const study = { source: "docs_url", sourceUri: "https://research.example.org/report", tags: ["cite"] };
const queued = () => queue.enqueueIngestionTicket.mock.calls[0]![1] as Record<string, unknown>;
const started = () => (job.triggerIngestionJob.mock.calls[0] as unknown[])[0] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  session.getAdminContext.mockResolvedValue(admin);
  queue.enqueueIngestionTicket.mockImplementation(async (_ctx: unknown, input: { onePage?: boolean }) => ({
    status: "created",
    ticketId: "tkt_1",
    onePage: input.onePage === true,
  }));
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/admin/knowledge/ingest — a source read as one page", () => {
  it("reads just the page given when asked to, and remembers that on the source", async () => {
    vi.stubEnv("CREATE_BLOG_CITE_SOURCES_ENABLED", "true");
    const res = await post({ ...study, onePage: true });
    expect(res.status).toBe(202);
    expect(queued()).toMatchObject({ sourceUri: "https://research.example.org/report", tags: ["cite"], onePage: true });
    expect(started().onePage).toBe(true);
  });

  it("re-reads a one-page source as one page when the request doesn't say", async () => {
    vi.stubEnv("CREATE_BLOG_CITE_SOURCES_ENABLED", "true");
    queue.enqueueIngestionTicket.mockResolvedValue({ status: "retried", ticketId: "tkt_1", onePage: true });
    await post(study);
    // Nothing said, so the queue keeps what the source already is…
    expect("onePage" in queued()).toBe(false);
    // …and the job is told what that is.
    expect(started().onePage).toBe(true);
  });

  it("crawls a code repo as ever — one page is a thing only a web page can be", async () => {
    vi.stubEnv("CREATE_BLOG_CITE_SOURCES_ENABLED", "true");
    queue.enqueueIngestionTicket.mockResolvedValue({ status: "created", ticketId: "tkt_1", onePage: true });
    await post({ source: "github", sourceUri: "https://github.com/acme/app", onePage: true });
    expect("onePage" in queued()).toBe(false);
    expect(started().onePage).toBe(false);
  });

  it("ignores the request while the flag is off: nothing new is stored and the job crawls", async () => {
    await post({ ...study, onePage: true });
    expect("onePage" in queued()).toBe(false);
    expect(started().onePage).toBe(false);
  });
});

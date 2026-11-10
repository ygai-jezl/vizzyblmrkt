import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const tenant = vi.hoisted(() => ({ getById: vi.fn(), isRateLimited: vi.fn(async () => false), getTenantById: vi.fn() }));
vi.mock("@/lib/tenant", () => ({
  forTenant: () => ({ workspaces: { getById: tenant.getById } }),
  isRateLimited: tenant.isRateLimited,
  getTenantById: tenant.getTenantById,
}));
const voice = vi.hoisted(() => ({ activeBrandVoiceText: vi.fn(async () => "Plain words.") }));
vi.mock("@/lib/content/create/activeBrandVoice", () => voice);
const gemini = vi.hoisted(() => ({
  isGeminiConfigured: vi.fn(() => true),
  generateTextStream: vi.fn(),
  prompts: [] as string[],
  signals: [] as (AbortSignal | undefined)[],
}));
vi.mock("@/lib/agents/gemini", () => ({ isGeminiConfigured: gemini.isGeminiConfigured, generateTextStream: gemini.generateTextStream }));

const { POST } = await import("./route");

const member = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1", role: "member" };

function replyWith(...chunks: string[]) {
  gemini.generateTextStream.mockImplementation(async function* (prompt: string, opts?: { signal?: AbortSignal }) {
    gemini.prompts.push(prompt);
    gemini.signals.push(opts?.signal);
    for (const c of chunks) yield c;
  });
}

const req = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/admin/editor/vizzy", {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost", ...headers },
    body: JSON.stringify(body),
  });

async function events(res: Response): Promise<{ type: string; [k: string]: unknown }[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)));
}

const selection = {
  format: "blog",
  mode: "selection",
  shape: "inline",
  instruction: "shorter",
  selection: "Most launches slip because the team tries everything.",
  workspaceId: "ws1",
};

beforeEach(() => {
  vi.clearAllMocks();
  gemini.prompts.length = 0;
  gemini.signals.length = 0;
  vi.stubEnv("NEXT_PUBLIC_EDIT_MODE_VIZZY_ENABLED", "true");
  vi.stubEnv("GRANTED_ONLY_FEATURES", "");
  session.getAdminContext.mockResolvedValue(member);
  tenant.getById.mockResolvedValue({ id: "ws1", brandVoice: "Workspace voice." });
  tenant.isRateLimited.mockResolvedValue(false);
  gemini.isGeminiConfigured.mockReturnValue(true);
  replyWith("Cut it to one ", "sentence.\n```ops\n", '{"replacement":"Most launches slip."}\n```');
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/admin/editor/vizzy", () => {
  it("streams the reply without the ops block, then the checked change", async () => {
    const res = await POST(req(selection));
    expect(res.status).toBe(200);
    const evs = await events(res);
    expect(evs.filter((e) => e.type === "text").map((e) => e.text).join("")).toBe("Cut it to one sentence.\n");
    expect(evs.filter((e) => e.type !== "text")).toEqual([
      { type: "selection", replacement: "Most launches slip.", warnings: [] },
      { type: "done" },
    ]);
    expect(voice.activeBrandVoiceText).toHaveBeenCalledWith("ten_A", "Workspace voice.");
    expect(gemini.prompts[0]).toContain("Plain words.");
    expect(gemini.signals[0]).toBeInstanceOf(AbortSignal);
  });

  it("sends why a change wasn't used", async () => {
    replyWith('Done.\n```ops\n{"replacement":"Most launches slip, see [this](https://evil.example)."}\n```');
    const evs = await events(await POST(req(selection)));
    expect(evs).toContainEqual({
      type: "error",
      message: "Vizzy's version added a link to https://evil.example that isn't in your text, so it wasn't used.",
    });
  });

  it("sends the edits for the whole piece with the ones skipped", async () => {
    replyWith('UK spelling.\n```ops\n{"ops":[{"op":"replace_all","find":"color","replace":"colour"},{"op":"bad"}]}\n```');
    const evs = await events(await POST(req({ format: "email", mode: "whole", instruction: "UK spelling", text: "<p>Color</p>" })));
    expect(evs).toContainEqual({
      type: "whole",
      ops: [{ op: { op: "replace_all", find: "color", replace: "colour" }, warnings: [] }],
      skipped: [{ excerpt: "", reason: "One suggested edit wasn't usable." }],
    });
    expect(voice.activeBrandVoiceText).toHaveBeenCalledWith("ten_A", undefined);
  });

  it("is off until switched on, before anything else is read", async () => {
    vi.stubEnv("NEXT_PUBLIC_EDIT_MODE_VIZZY_ENABLED", "false");
    const res = await POST(req(selection));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "edit_vizzy_disabled" });
    expect(session.getAdminContext).not.toHaveBeenCalled();
  });

  it("refuses another site, a stranger, a brand without it, a bad body, too many and an unknown workspace", async () => {
    expect((await POST(req(selection, { origin: "https://evil.example" }))).status).toBe(403);
    session.getAdminContext.mockResolvedValueOnce(null);
    expect((await POST(req(selection))).status).toBe(401);
    vi.stubEnv("GRANTED_ONLY_FEATURES", "edit_vizzy");
    tenant.getTenantById.mockResolvedValueOnce({ grantedFeatures: [] });
    const notIncluded = await POST(req(selection));
    expect(notIncluded.status).toBe(403);
    expect(await notIncluded.json()).toEqual({ error: "not_included" });
    vi.stubEnv("GRANTED_ONLY_FEATURES", "");
    expect((await POST(req({ ...selection, instruction: "" }))).status).toBe(400);
    tenant.isRateLimited.mockResolvedValueOnce(true);
    expect((await POST(req(selection))).status).toBe(429);
    tenant.getById.mockResolvedValueOnce(null);
    expect((await POST(req(selection))).status).toBe(404);
    expect(gemini.generateTextStream).not.toHaveBeenCalled();
  });

  it("says so when the model is quiet or AI isn't set up", async () => {
    replyWith();
    expect(await events(await POST(req(selection)))).toContainEqual({
      type: "error",
      message: "Vizzy couldn't reach the model just now. Try again.",
    });
    gemini.isGeminiConfigured.mockReturnValueOnce(false);
    expect((await POST(req(selection))).status).toBe(503);
  });

  it("counts against the brand, not the person", async () => {
    await events(await POST(req(selection)));
    expect(tenant.isRateLimited).toHaveBeenCalledWith("tenant:ten_A", expect.objectContaining({ prefix: "edit_vizzy" }));
  });
});

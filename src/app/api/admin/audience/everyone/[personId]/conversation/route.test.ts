import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Read the conversation: admins only, as export is.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const voice = vi.hoisted(() => ({ loadVoiceChat: vi.fn() }));
vi.mock("@/lib/audience/voiceChat", () => voice);

const { GET } = await import("./route");

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1", role: "admin" };
const call = (personId: string, signup = "s1") =>
  GET(new Request(`http://localhost/api/admin/audience/everyone/${personId}/conversation?signup=${signup}`), { params: Promise.resolve({ personId }) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true");
  vi.stubEnv("AUDIENCE_ONE_VIEW_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(admin);
  voice.loadVoiceChat.mockResolvedValue({ signupId: "s1", turns: [] });
});
afterEach(() => vi.unstubAllEnvs());

describe("GET a person's voice chat", () => {
  it("doesn't exist while the one view is off", async () => {
    vi.stubEnv("AUDIENCE_ONE_VIEW_ENABLED", "false");
    expect((await call("ct_1")).status).toBe(404);
    expect(voice.loadVoiceChat).not.toHaveBeenCalled();
  });

  it("is for admins only", async () => {
    session.getAdminContext.mockResolvedValue(null);
    expect((await call("ct_1")).status).toBe(401);
    session.getAdminContext.mockResolvedValue({ ...admin, role: "member" });
    expect((await call("ct_1")).status).toBe(403);
    expect(voice.loadVoiceChat).not.toHaveBeenCalled();
  });

  it("gives the chat for the signed-in brand, or not found", async () => {
    const res = await call("ct_1", "s1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ chat: { signupId: "s1", turns: [] } });
    expect(voice.loadVoiceChat).toHaveBeenCalledWith(admin, "ct_1", "s1");
    voice.loadVoiceChat.mockResolvedValue(null);
    expect((await call("ct_1", "s2")).status).toBe(404);
  });
});

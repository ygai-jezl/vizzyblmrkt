import { describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { deterministicContactId } from "@/lib/crm/identifiers";
import { loadVoiceChat } from "./voiceChat";

const ctx: TenantContext = { tenantId: "ten_A", region: "eu", source: "idtoken", role: "admin", userId: "u_admin" };
const AT = "2026-11-14T10:00:00.000Z";
const PRIYA = deterministicContactId("ten_A", "priya@example.com");
const chat = { completed: true, transcript: [{ role: "model", text: "What brings you here?" }, { role: "user", text: "Mostly reporting." }], summary: " Wants exports to Sheets. ", capturedAt: AT, bonusApplied: true };

function world() {
  const db = new FakeFirestore();
  db.seed("campaigns", "camp1", { tenantId: "ten_A", waitlistName: "Spring launch" });
  db.seed("contacts", PRIYA, { tenantId: "ten_A", email: "priya@example.com", firstName: "Priya", lastName: "Shah", campaigns: [{ campaignId: "camp1", signupId: "s_linked" }] });
  db.seed("signups", "s_linked", { tenantId: "ten_A", campaignId: "camp1", email: "other@example.com", aiConversation: chat });
  db.seed("signups", "s_address", { tenantId: "ten_A", campaignId: "camp1", email: "Priya@Example.com", aiConversation: chat });
  db.seed("signups", "s_someone", { tenantId: "ten_A", campaignId: "camp1", email: "sam@example.com", aiConversation: chat });
  db.seed("signups", "s_unfinished", { tenantId: "ten_A", campaignId: "camp1", email: "priya@example.com", aiConversation: { ...chat, completed: false } });
  db.seed("signups", "s_dropped", { tenantId: "ten_A", campaignId: "camp1", email: "priya@example.com", aiConversation: { ...chat, transcript: [{ role: "model", text: "Hello?" }] } });
  return db;
}

describe("loadVoiceChat", () => {
  it("gives one of their chats in full, with its unchecked summary", async () => {
    const r = await loadVoiceChat(ctx, PRIYA, "s_linked", world());
    expect(r).toEqual({
      signupId: "s_linked",
      launchName: "Spring launch",
      brandName: "your brand",
      personName: "Priya Shah",
      at: AT,
      summary: "Wants exports to Sheets.",
      turns: [
        { role: "model", text: "What brings you here?" },
        { role: "user", text: "Mostly reporting." },
      ],
    });
    expect((await loadVoiceChat(ctx, PRIYA, "s_address", world()))?.signupId).toBe("s_address");
  });

  it("finds nothing for someone else's sign-up, an unfinished or empty chat, a bad id or another brand", async () => {
    const db = world();
    expect(await loadVoiceChat(ctx, PRIYA, "s_someone", db)).toBeNull();
    expect(await loadVoiceChat(ctx, PRIYA, "s_unfinished", db)).toBeNull();
    expect(await loadVoiceChat(ctx, PRIYA, "s_dropped", db)).toBeNull();
    expect(await loadVoiceChat(ctx, PRIYA, "../s_linked", db)).toBeNull();
    expect(await loadVoiceChat({ ...ctx, tenantId: "ten_B" }, PRIYA, "s_linked", db)).toBeNull();
  });
});

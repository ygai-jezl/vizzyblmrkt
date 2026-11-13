import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  forgetAllEditMemories,
  forgetEditMemory,
  learnFromEdits,
  listEditMemories,
  memoryScope,
  type MemoryBankIo,
} from "./memoryBank";

const BANK = "https://us-central1-aiplatform.googleapis.com/v1beta1/projects/demo-yougrow/locations/us-central1/reasoningEngines/123";
const me = { tenantId: "ten_A", userId: "u1" };
const name = (id: string) => `projects/demo-yougrow/locations/us-central1/reasoningEngines/123/memories/${id}`;

function fakeIo(answers: Record<string, unknown>): MemoryBankIo & { calls: { method: string; url: string; body: unknown }[] } {
  const calls: { method: string; url: string; body: unknown }[] = [];
  return {
    calls,
    token: async () => "token",
    fetch: (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      const key = `${method} ${url.replace(BANK, "")}`;
      if (!(key in answers)) return new Response("", { status: 404 });
      return new Response(JSON.stringify(answers[key]), { status: 200 });
    }) as typeof fetch,
  };
}

beforeEach(() => {
  vi.stubEnv("VIZZY_MEMORY_BANK_ID", "123");
  vi.stubEnv("GOOGLE_CLOUD_PROJECT", "demo-yougrow");
  vi.stubEnv("ROOT_AGENT_LOCATION", "us-central1");
});
afterEach(() => vi.unstubAllEnvs());

describe("the scope", () => {
  it("is the person's brand and themselves, from the session", () => {
    expect(memoryScope(me)).toEqual({ tenant_id: "ten_A", user_id: "u1" });
    expect(() => memoryScope({ tenantId: "ten_A", userId: undefined })).toThrow();
    expect(() => memoryScope({ tenantId: "ten_*", userId: "u1" })).toThrow();
  });
});

describe("reading and forgetting", () => {
  const mine = { name: name("1"), fact: "The user keeps intros short.", scope: { tenant_id: "ten_A", user_id: "u1" }, createTime: "2026-11-01T00:00:00Z" };
  const asked = {
    name: name("2"),
    fact: "The user writes in UK English.",
    scope: { user_id: "u1", tenant_id: "ten_A" },
    createTime: "2026-11-02T00:00:00Z",
    topics: [{ managedMemoryTopic: "EXPLICIT_INSTRUCTIONS" }],
  };
  const someoneElse = { name: name("3"), fact: "Theirs.", scope: { tenant_id: "ten_B", user_id: "u1" } };

  it("lists the person's memories, newest first, asking only for their scope", async () => {
    const io = fakeIo({ "POST /memories:retrieve": { retrievedMemories: [{ memory: mine }, { memory: asked }, { memory: someoneElse }] } });
    expect(await listEditMemories(me, io)).toEqual([
      { id: "2", text: "Writes in UK English.", source: "asked", createdAt: "2026-11-02T00:00:00Z" },
      { id: "1", text: "Keeps intros short.", source: "learned", createdAt: "2026-11-01T00:00:00Z" },
    ]);
    expect(io.calls[0]).toMatchObject({ method: "POST", body: { scope: { tenant_id: "ten_A", user_id: "u1" } } });
  });

  it("forgets a memory only when it is the person's own", async () => {
    const io = fakeIo({ "GET /memories/1": mine, "GET /memories/3": someoneElse, "DELETE /memories/1": {} });
    expect(await forgetEditMemory(me, "1", io)).toBe(true);
    expect(await forgetEditMemory(me, "3", io)).toBe(false);
    expect(await forgetEditMemory(me, "../evil", io)).toBe(false);
    expect(io.calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([`${BANK}/memories/1`]);
  });

  it("forgets everything in the person's scope by name", async () => {
    const io = fakeIo({
      "POST /memories:retrieve": { retrievedMemories: [{ memory: mine }, { memory: asked }, { memory: someoneElse }] },
      "DELETE /memories/1": {},
      "DELETE /memories/2": {},
    });
    expect(await forgetAllEditMemories(me, io)).toBe(2);
  });
});

describe("learning", () => {
  it("sends one line per change, with only the changed words, under the person's scope", async () => {
    const io = fakeIo({ "POST /memories:generate": { name: "operations/1" } });
    await learnFromEdits(
      me,
      [{ instruction: "use UK spelling", kind: "whole", outcome: "kept", before: "Keep the color the same", after: "Keep the colour the same" }],
      io,
    );
    expect(io.calls[0]).toEqual({
      method: "POST",
      url: `${BANK}/memories:generate`,
      body: {
        scope: { tenant_id: "ten_A", user_id: "u1" },
        directContentsSource: {
          events: [
            {
              content: {
                role: "user",
                parts: [{ text: 'I asked Vizzy, across the whole text: "use UK spelling". Vizzy changed "color" to "colour". I kept the change.' }],
              },
            },
          ],
        },
      },
    });
  });

  it("refuses to run without a Memory Bank", async () => {
    vi.stubEnv("VIZZY_MEMORY_BANK_ID", "");
    await expect(listEditMemories(me, fakeIo({}))).rejects.toThrow("memory_bank_not_configured");
  });
});

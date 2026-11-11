import type { TenantContext } from "@/lib/tenant/types";
import { learningEventText, memoryLabel, type LearnEntry } from "@/lib/content/editor/vizzyLearning";
import { agentLocation, getAccessToken } from "./agentRuntime";

/**
 * What Vizzy learns about how each person edits, in an Agent Platform Memory Bank of its own
 * (infra/agent/setup.sh memory makes it; VIZZY_MEMORY_BANK_ID names it). Server only, over the
 * v1beta1 REST API with the runtime's own credentials.
 *
 * Isolation: Memory Bank only returns or merges memories whose scope matches exactly, and a
 * memory's scope never changes. The scope is built in one place, `memoryScope`, from the
 * session's tenant and user, never from anything the browser sends. A memory id from the
 * browser is only acted on after its scope is checked against the person's own.
 */

export interface EditMemory {
  id: string;
  /** As the panel shows it ("Keeps intros short."). */
  text: string;
  /** "asked": the person told Vizzy to remember it. "learned": from their edits. */
  source: "asked" | "learned";
  createdAt: string | null;
}

export interface MemoryBankIo {
  fetch: typeof fetch;
  token: () => Promise<string>;
}

const defaultIo = (): MemoryBankIo => ({ fetch: globalThis.fetch, token: getAccessToken });

export function memoryBankId(): string | null {
  const id = process.env.VIZZY_MEMORY_BANK_ID?.trim();
  return id && /^[0-9]{1,30}$/.test(id) ? id : null;
}

export function isMemoryBankConfigured(): boolean {
  return Boolean(memoryBankId() && process.env.GOOGLE_CLOUD_PROJECT);
}

function bankUrl(): string {
  const id = memoryBankId();
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!id || !project) throw new Error("memory_bank_not_configured");
  const location = agentLocation();
  return `https://${location}-aiplatform.googleapis.com/v1beta1/projects/${project}/locations/${location}/reasoningEngines/${id}`;
}

/** The one scope a person's editing memories live under: their brand and themselves. */
export function memoryScope(ctx: Pick<TenantContext, "tenantId" | "userId">): { tenant_id: string; user_id: string } {
  const { tenantId, userId } = ctx;
  if (!tenantId || !userId || tenantId.includes("*") || userId.includes("*")) throw new Error("memory_scope_invalid");
  return { tenant_id: tenantId, user_id: userId };
}

function sameScope(a: unknown, b: Record<string, string>): boolean {
  if (!a || typeof a !== "object") return false;
  const got = a as Record<string, unknown>;
  const keys = Object.keys(got);
  return keys.length === Object.keys(b).length && keys.every((k) => got[k] === b[k]);
}

async function call(io: MemoryBankIo, method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<unknown> {
  const res = await io.fetch(`${bankUrl()}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await io.token()}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`memory_bank_${res.status}`);
  const text = await res.text();
  return text ? (JSON.parse(text) as unknown) : {};
}

interface RawMemory {
  name?: string;
  fact?: string;
  scope?: Record<string, string>;
  createTime?: string;
  topics?: { managedMemoryTopic?: string; customMemoryTopicLabel?: string }[];
}

const MEMORY_ID = /\/memories\/([A-Za-z0-9_-]{1,64})$/;

function toEditMemory(m: RawMemory): EditMemory | null {
  const id = m.name?.match(MEMORY_ID)?.[1];
  if (!id || !m.fact?.trim()) return null;
  const asked = (m.topics ?? []).some((t) => t.managedMemoryTopic === "EXPLICIT_INSTRUCTIONS");
  return { id, text: memoryLabel(m.fact), source: asked ? "asked" : "learned", createdAt: m.createTime ?? null };
}

/** What a person's raw memories are (scope already matched by the API). */
async function rawMemories(ctx: Pick<TenantContext, "tenantId" | "userId">, io: MemoryBankIo): Promise<RawMemory[]> {
  const out = (await call(io, "POST", "/memories:retrieve", { scope: memoryScope(ctx) })) as {
    retrievedMemories?: { memory?: RawMemory }[];
  } | null;
  return (out?.retrievedMemories ?? []).map((r) => r.memory ?? {});
}

/** The person's editing memories, newest first, at most 20. */
export async function listEditMemories(
  ctx: Pick<TenantContext, "tenantId" | "userId">,
  io: MemoryBankIo = defaultIo(),
): Promise<EditMemory[]> {
  const scope = memoryScope(ctx);
  return (await rawMemories(ctx, io))
    .filter((m) => sameScope(m.scope, scope))
    .map(toEditMemory)
    .filter((m): m is EditMemory => m !== null)
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
    .slice(0, 20);
}

/** Learn from what the person kept and undid. Memory Bank works on it in the background; this
 *  returns once it has the request. */
export async function learnFromEdits(
  ctx: Pick<TenantContext, "tenantId" | "userId">,
  entries: readonly LearnEntry[],
  io: MemoryBankIo = defaultIo(),
): Promise<void> {
  if (!entries.length) return;
  await call(io, "POST", "/memories:generate", {
    scope: memoryScope(ctx),
    directContentsSource: {
      events: entries.map((e) => ({ content: { role: "user", parts: [{ text: learningEventText(e) }] } })),
    },
  });
}

/** One of the person's memories, or null when there's none with that id in their scope. */
export async function getEditMemory(
  ctx: Pick<TenantContext, "tenantId" | "userId">,
  id: string,
  io: MemoryBankIo = defaultIo(),
): Promise<EditMemory | null> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  const m = (await call(io, "GET", `/memories/${id}`)) as RawMemory | null;
  if (!m || !sameScope(m.scope, memoryScope(ctx))) return null;
  return toEditMemory(m);
}

/** Forget one memory, only when it is the person's own. False: there's no such memory. */
export async function forgetEditMemory(
  ctx: Pick<TenantContext, "tenantId" | "userId">,
  id: string,
  io: MemoryBankIo = defaultIo(),
): Promise<boolean> {
  if (!(await getEditMemory(ctx, id, io))) return false;
  await call(io, "DELETE", `/memories/${id}`);
  return true;
}

/** Forget everything Vizzy has learned about how this person edits in this brand. */
export async function forgetAllEditMemories(
  ctx: Pick<TenantContext, "tenantId" | "userId">,
  io: MemoryBankIo = defaultIo(),
): Promise<number> {
  const scope = memoryScope(ctx);
  let forgotten = 0;
  for (const m of await rawMemories(ctx, io)) {
    const id = m.name?.match(MEMORY_ID)?.[1];
    if (!id || !sameScope(m.scope, scope)) continue;
    await call(io, "DELETE", `/memories/${id}`);
    forgotten += 1;
  }
  return forgotten;
}

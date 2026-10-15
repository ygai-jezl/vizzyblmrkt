import { renderPrompt } from "@/lib/agents/prompts/registry";
import { generateTextWithDeadline, isGeminiConfigured } from "@/lib/agents/gemini";
import { brandMapRecords, type BrandMapRecordStore } from "@/lib/tenant/brandMapRecords";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { BRAND_MAP_RECORD_LIMITS as LIMITS, BrandMapGroupSchema } from "@/lib/types/brandMapRecords";
import { groupIdFor, subjectKey } from "./keys";
import { listGroups, parseGroup, parseSubject } from "./records";
import { readBrandMap } from "./store";

/**
 * "Sort into groups" on a map at any size (BRAND_MAP_SCALE_ENABLED): subjects in no group are
 * read a batch at a time, and the model puts each in a group the map has, or names a new one
 * for two or more that belong together. Nothing moves by itself: a new group is PROPOSED, and
 * each subject only gets a suggested group (`suggestedGroupId`), which a person accepts with
 * the group (proposals.ts) or answers by moving it. A group a person dismissed is never
 * proposed again. A batch is one step of a "groups" run (runs.ts).
 */

export const SORT_BATCH = 300;
const MAX_NEW_GROUPS = 30;
const SORT_MS = 50_000;

const clean = (s: string) => s.replace(/\s+/g, " ").replace(/^["“”'*]+|["“”'*]+$/g, "").trim();
const hasAddress = (s: string) => /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|io|ai|co|dev|app)\/\S/i.test(s);

/** The answer's GROUP lines: a name and the numbers of its subjects (each subject once, the first line wins). */
export function parseGroupLines(text: string, subjects: number): Array<{ name: string; members: number[] }> {
  const taken = new Set<number>();
  const out: Array<{ name: string; members: number[] }> = [];
  for (const raw of (text ?? "").split(/\r?\n/)) {
    const m = /^\s*(?:[-*•]\s*)?\**GROUP\**\s*:\**\s*(.+?)\s*\|\s*(.+)$/i.exec(raw);
    if (!m || hasAddress(raw)) continue;
    const name = clean(m[1] ?? "").slice(0, LIMITS.groupName);
    if (!name) continue;
    const members = (m[2] ?? "")
      .split(/[\s,;]+/)
      .map((n) => Number(n.replace(/\D/g, "")))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= subjects && !taken.has(n));
    for (const n of members) taken.add(n);
    if (members.length) out.push({ name, members: [...new Set(members)] });
  }
  return out;
}

export interface SortDeps {
  db?: FirestoreLike;
  nowMs?: number;
  generate?: (prompt: string) => Promise<string | null>;
  modelReady?: () => boolean;
}

export type SortResult =
  | { ok: true; done: boolean; next: string | null; read: number; suggested: number; proposedGroups: string[] }
  | { ok: false; status: number; error: string };

/** How many subjects wait on each of these groups, kept on the group for lists (display only). */
export async function refreshSuggested(store: BrandMapRecordStore, groupIds: string[]): Promise<void> {
  for (const id of new Set(groupIds)) {
    const n = await store.count("sub", [["suggestedGroupId", "==", id]]).catch(() => null);
    if (n !== null) await store.claim("grp", id, (cur) => (Number(cur.suggested ?? 0) === n ? null : { suggested: n })).catch(() => null);
  }
}

/** One batch: the subjects in no group after `cursor`, given suggested groups. */
export async function sortIntoGroups(ctx: TenantContext, input: { cursor: string | null }, deps: SortDeps = {}): Promise<SortResult> {
  if (!(deps.modelReady ?? isGeminiConfigured)()) return { ok: false, status: 503, error: "no_model" };
  const now = new Date(deps.nowMs ?? Date.now()).toISOString();
  const store = brandMapRecords(ctx, deps.db);
  const batch = await store.find("sub", {
    where: [["groupId", "==", null]],
    orderBy: [["ref", "asc"]],
    ...(input.cursor ? { startAfter: [input.cursor] } : {}),
    limit: SORT_BATCH,
  });
  const done = batch.length < SORT_BATCH;
  const next = done ? null : batch[batch.length - 1]!.id;
  const subjects = batch.flatMap((raw) => {
    const s = parseSubject(raw);
    return s && s.status !== "dismissed" && !s.mergedInto && !s.suggestedGroupId ? [s] : [];
  });
  if (!subjects.length) return { ok: true, done, next, read: batch.length, suggested: 0, proposedGroups: [] };

  const [groups, read] = await Promise.all([listGroups(ctx, deps), readBrandMap(ctx, deps.db).catch(() => null)]);
  const identity = read?.state === "ok" ? read.map.identity : null;
  const prompt = renderPrompt("brand.map_groups", {
    brand_name: (identity?.name ?? "").replace(/["\n]/g, " ").slice(0, 120) || "(not named)",
    category: identity?.category ? `, in the category "${identity.category.replace(/["\n]/g, " ").slice(0, 80)}"` : "",
    groups: groups.map((g) => `- ${g.name}`).join("\n") || "(none yet)",
    subjects: subjects.map((s, i) => `${i + 1}. ${s.name}`).join("\n"),
    max_new: MAX_NEW_GROUPS,
  });
  const answer = await (deps.generate ?? ((p: string) => generateTextWithDeadline(p, { timeoutMs: SORT_MS })))(prompt).catch(() => null);
  if (answer === null) return { ok: false, status: 502, error: "research_failed" };

  const byKey = new Map(groups.map((g) => [g.nameKey, g.id]));
  let total = await store.count("grp").catch(() => groups.length);
  let made = 0;
  const proposedGroups: string[] = [];
  const touched: string[] = [];
  let suggested = 0;
  for (const line of parseGroupLines(answer, subjects.length)) {
    const key = subjectKey(line.name);
    if (!key) continue;
    let gid = byKey.get(key) ?? null;
    if (!gid) {
      // A new group needs two subjects, room on the map, and not to have been dismissed before.
      if (line.members.length < 2 || made >= MAX_NEW_GROUPS || total >= LIMITS.groups) continue;
      const record = BrandMapGroupSchema.parse({
        id: groupIdFor(ctx.tenantId, line.name),
        tenantId: ctx.tenantId,
        status: "proposed",
        from: "research",
        reason: "Proposed to sort your subjects",
        createdAt: now,
        updatedAt: now,
        name: line.name,
        nameKey: key,
        order: total,
      });
      const { id, tenantId: _t, ...data } = record;
      void _t;
      const created = await store.createIfAbsent("grp", id, data);
      const group = created ? parseGroup(created) : parseGroup(await store.get("grp", id));
      if (!group || group.status === "dismissed") continue;
      if (created) {
        made += 1;
        total += 1;
        proposedGroups.push(group.name);
      }
      gid = group.id;
      byKey.set(key, gid);
    }
    for (const n of line.members) {
      const subject = subjects[n - 1]!;
      const set = await store
        .claim("sub", subject.id, (cur) => (cur.groupId == null && !cur.suggestedGroupId && cur.status !== "dismissed" && !cur.mergedInto ? { suggestedGroupId: gid, updatedAt: now } : null))
        .catch(() => null);
      if (set) suggested += 1;
    }
    touched.push(gid);
  }
  await refreshSuggested(store, touched);
  return { ok: true, done, next, read: batch.length, suggested, proposedGroups };
}

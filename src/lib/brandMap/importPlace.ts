import { renderPrompt } from "@/lib/agents/prompts/registry";
import { generateTextWithDeadline, isGeminiConfigured } from "@/lib/agents/gemini";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { BRAND_MAP_RECORD_LIMITS as LIMITS, type ImportItem } from "@/lib/types/brandMapRecords";
import { NAME_KIND_LABEL } from "./changes";
import { nearestSubjectsMany, type EmbedDeps } from "./embed";
import { isBrandMapSituationsEnabled } from "./flags";
import { getImport, type ImportResult } from "./imports";
import { questionKey, subjectKey } from "./keys";
import { listGroups } from "./records";
import { listSituations } from "./situations";
import { readBrandMap } from "./store";

/**
 * Placing a brand's own research on its map (BRAND_MAP_IMPORT_ENABLED), a batch of 40 items
 * per step of the import's run, the browser driving it as research does. One model call puts
 * each item in one of the subjects nearest it in meaning, or names a new subject; turns a
 * search into the question it implies ("AI search optimization tools" → "Which AI search
 * optimization tools are worth using?"); says which of the answer's headings it falls under,
 * and the buying situation it clearly belongs to; or says why it doesn't fit. Headings are
 * matched to the map's groups once. An item the map has already (by its words) isn't asked
 * about. Nothing is added here: a person adds what they tick (importCompare.ts).
 */

export const PLACE_BATCH = 40;
const NEAR_EACH = 6;
const MAX_SUBJECTS = 60;
const MAX_SITUATIONS = 30;
const PLACE_MS = 55_000;

const clean = (s: string) => s.replace(/\s+/g, " ").replace(/^["“”'*]+|["“”'*]+$/g, "").trim();
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const hasAddress = (s: string) => /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|io|ai|co|dev|app|uk)\/\S/i.test(s);
const fence = (tag: string, text: string) => text.replace(new RegExp(`</?\\s*${tag}[^>]*>`, "gi"), " ");
const numberOf = (s: string, letter: string) => {
  const m = new RegExp(`^${letter}\\s*(\\d{1,3})$`, "i").exec(s.trim());
  return m ? Number(m[1]) : null;
};

/** An item placing is about: a question or a search, not looked at yet, not added. */
export const placeable = (i: ImportItem) => (i.kind === "ask" || i.kind === "also" || i.kind === "question") && !i.tried && !i.questionId;

export interface PlaceLines {
  places: Array<{ i: number; question: string; subject: { n: number } | { name: string } | null; theme: string; situation: number | null }>;
  nofit: Array<{ i: number; why: string }>;
  themes: Array<{ name: string; group: number | null }>;
}

/** The answer's PLACE, NOFIT and THEME lines, each checked against what was listed. */
export function parsePlaceLines(text: string, n: { items: number; subjects: number; groups: number; situations: number }): PlaceLines {
  const out: PlaceLines = { places: [], nofit: [], themes: [] };
  const seen = new Set<number>();
  for (const raw of (text ?? "").split(/\r?\n/)) {
    const m = /^\s*(?:[-*•]\s*)?\**(PLACE|NOFIT|THEME)\**\s*:\**\s*(.+)$/i.exec(raw);
    if (!m || hasAddress(raw)) continue;
    const parts = (m[2] ?? "").split(/\s*\|\s*/).map(clean);
    const kind = (m[1] ?? "").toUpperCase();
    if (kind === "THEME") {
      const name = (parts[0] ?? "").slice(0, LIMITS.label);
      const g = numberOf(parts[1] ?? "", "G");
      if (name) out.themes.push({ name, group: g && g <= n.groups ? g : null });
      continue;
    }
    const i = numberOf(parts[0] ?? "", "I");
    if (!i || i > n.items || seen.has(i)) continue;
    seen.add(i);
    if (kind === "NOFIT") {
      out.nofit.push({ i, why: (parts[1] ?? "").slice(0, LIMITS.reason) });
      continue;
    }
    const where = parts[2] ?? "";
    const s = numberOf(where, "S");
    const fresh = /^NEW\s*:\s*(.+)$/i.exec(where);
    const t = numberOf(parts[4] ?? "", "T");
    out.places.push({
      i,
      question: (parts[1] ?? "").slice(0, LIMITS.questionText),
      subject: s && s <= n.subjects ? { n: s } : fresh?.[1] ? { name: clean(fresh[1]).slice(0, LIMITS.subjectName) } : null,
      theme: /^none$/i.test(parts[3] ?? "") ? "" : (parts[3] ?? "").slice(0, LIMITS.label),
      situation: t && t <= n.situations ? t : null,
    });
  }
  return out;
}

export interface PlaceDeps {
  db?: FirestoreLike;
  nowMs?: number;
  modelReady?: () => boolean;
  generate?: (prompt: string) => Promise<string | null>;
  embed?: Omit<EmbedDeps, "db" | "nowMs">;
}

/** One batch of an import placed: hands back whether any are left. */
export async function placeImport(ctx: TenantContext, importId: string, deps: PlaceDeps = {}): Promise<ImportResult<{ done: boolean; placed: number; noFit: number }>> {
  if (!(deps.modelReady ?? isGeminiConfigured)()) return { ok: false, status: 503, error: "no_model" };
  const store = brandMapRecords(ctx, deps.db);
  const imp = await getImport(ctx, importId, deps);
  if (!imp) return { ok: false, status: 404, error: "no_import" };
  const items = imp.items.map((i) => ({ ...i }));
  const pending = items.filter(placeable);
  if (!pending.length) {
    if (!imp.placed) await store.claim("imp", imp.id, () => ({ placed: true }));
    return { ok: true, value: { done: true, placed: 0, noFit: 0 } };
  }

  // One the map has already, by its words, isn't asked about.
  const window = pending.slice(0, PLACE_BATCH);
  const onMap = new Set(
    (await store.findIn("q", "textKey", window.map((i) => questionKey(i.text)).filter(Boolean)).catch(() => []))
      .filter((q) => q.status !== "dismissed")
      .map((q) => String(q.textKey)),
  );
  const batch = window.filter((i) => !onMap.has(questionKey(i.text)));
  for (const i of window) i.tried = true;

  let placed = 0;
  let noFit = 0;
  let themes = imp.themes;
  if (batch.length) {
    const near = await nearestSubjectsMany(ctx, batch.map((i) => i.text), { limit: NEAR_EACH, statuses: ["decided", "proposed"] }, { db: deps.db, ...deps.embed });
    const refs = [...new Set(near.flat().map((n) => n.ref))].slice(0, MAX_SUBJECTS);
    const subjects = (await store.getMany("sub", refs).catch(() => [])).flatMap((r) =>
      typeof r.name === "string" && r.status !== "dismissed" && !r.mergedInto ? [{ id: r.id, name: r.name }] : [],
    );
    const [groups, situations, read] = await Promise.all([
      listGroups(ctx, deps).then((g) => g.filter((x) => x.status === "decided")),
      isBrandMapSituationsEnabled() ? listSituations(ctx, deps).then((s) => s.filter((x) => x.status === "decided").slice(0, MAX_SITUATIONS)) : Promise.resolve([]),
      readBrandMap(ctx, deps.db).catch(() => null),
    ]);
    const map = read?.state === "ok" ? read.map : null;
    const identity = map?.identity;
    // The answer's headings are matched to the map's groups once, with the first batch.
    const askThemes = themes.length > 0 && !items.some((i) => i.tried && !window.includes(i));
    const prompt = renderPrompt("brand.map_import_place", {
      brand_name: oneLine(identity?.name ?? "").replace(/"/g, " ").slice(0, 120) || "(not named)",
      category: identity?.category ? `, in the category "${oneLine(identity.category).replace(/"/g, " ").slice(0, 80)}"` : "",
      identity: fence(
        "brand",
        [
          identity?.statement ? `What it is: ${identity.statement}` : "",
          ...(map?.names ?? []).filter((n) => n.kind !== "alternative").slice(0, 20).map((n) => `${NAME_KIND_LABEL[n.kind]}: ${n.name}`),
        ]
          .filter(Boolean)
          .join("\n") || "(not set yet)",
      ),
      items: fence(
        "items",
        batch.map((it, k) => `I${k + 1}. ${it.kind === "also" ? "A search" : "A question"}: ${oneLine(it.text)}${it.search ? ` (found searching "${oneLine(it.search)}")` : ""}`).join("\n"),
      ),
      subjects: fence("subjects", subjects.map((s, k) => `S${k + 1}. ${oneLine(s.name)}`).join("\n") || "(none near)"),
      themes: fence("themes", themes.map((t) => `- ${oneLine(t.name)}`).join("\n") || "(none)"),
      groups: fence("groups", groups.map((g, k) => `G${k + 1}. ${oneLine(g.name)}`).join("\n") || "(none yet)"),
      situations: fence("situations", situations.map((s, k) => `T${k + 1}. “${oneLine(s.text)}”`).join("\n") || "(none)"),
      themes_task: askThemes ? "- For each heading above, say which group on the map it matches, by number, or NEW.\n" : "",
      themes_format: askThemes ? "\nTHEME: <a heading from the list> | <G number, or NEW>" : "",
    });
    const answer = await (deps.generate ?? ((p: string) => generateTextWithDeadline(p, { timeoutMs: PLACE_MS })))(prompt).catch(() => null);
    if (answer === null) return { ok: false, status: 502, error: "research_failed" };
    const lines = parsePlaceLines(answer, { items: batch.length, subjects: subjects.length, groups: groups.length, situations: situations.length });

    const themeByName = new Map(themes.map((t) => [t.name.toLowerCase(), t.name]));
    const byKey = new Map(subjects.map((s) => [subjectKey(s.name), s.id]));
    for (const p of lines.places) {
      const item = batch[p.i - 1]!;
      const question = item.kind === "also" ? p.question : item.text;
      if (!question || hasAddress(question)) continue;
      if (p.subject && "n" in p.subject) item.subjectId = subjects[p.subject.n - 1]!.id;
      else if (p.subject) {
        // A "new" subject the map has by its folded name is that one.
        const [same] = byKey.has(subjectKey(p.subject.name))
          ? [{ id: byKey.get(subjectKey(p.subject.name))! }]
          : await store.find("sub", { where: [["nameKey", "==", subjectKey(p.subject.name)]], limit: 1 }).catch(() => []);
        if (same && (same as { status?: unknown }).status !== "dismissed") item.subjectId = same.id;
        else item.newSubject = p.subject.name;
      } else continue;
      item.asQuestion = item.kind === "also" ? question : "";
      item.theme = themeByName.get(p.theme.toLowerCase()) ?? "";
      item.situationId = p.situation ? situations[p.situation - 1]!.id : null;
      item.fits = true;
      placed += 1;
    }
    for (const f of lines.nofit) {
      const item = batch[f.i - 1]!;
      item.fits = false;
      item.why = f.why;
      noFit += 1;
    }
    if (askThemes) {
      const matched = new Map(lines.themes.filter((t) => t.group).map((t) => [t.name.toLowerCase(), groups[t.group! - 1]!.id]));
      themes = themes.map((t) => ({ ...t, groupId: matched.get(t.name.toLowerCase()) ?? t.groupId }));
    }
  }
  const done = !items.some(placeable);
  await store.claim("imp", imp.id, () => ({ items, themes, placed: done }));
  return { ok: true, value: { done, placed, noFit } };
}

import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { BrandMapChange } from "@/lib/types/brandMap";
import type { RecordFrom } from "@/lib/types/brandMapRecords";
import { normalizeUrl } from "@/lib/content/blog/brief";
import { isBrandMapScaleEnabled } from "./flags";
import { subjectKey } from "./keys";
import { embedSubjects } from "./embed";
import { ensureMoved } from "./move";
import { proposedQuestion, proposedSubject } from "./proposals";
import { fileBrandMapSuggestions, readBrandMap, type FileInput, type Filed, type MapResult } from "./store";

/**
 * Filing what research, an article or Vizzy suggests for the brand map. With the map at any
 * size on, a suggestion about a subject (add one, add a question to one, a subject's home
 * page) becomes a PROPOSAL on the records — the map is moved first if it hasn't been — and
 * everything else is filed on the brand's record as before. Off, this is exactly
 * fileBrandMapSuggestions.
 */

const ABOUT_SUBJECTS = new Set<BrandMapChange["type"]>(["add_subject", "add_question"]);
const aboutSubjects = (c: BrandMapChange) => ABOUT_SUBJECTS.has(c.type) || (c.type === "set_home" && c.target === "subject");

export type FiledWithProposals = Filed & {
  /** What became a proposal on the records, said in a few words each. */
  proposed: string[];
};

export async function fileSuggestions(
  ctx: TenantContext,
  input: FileInput,
  deps: { db?: FirestoreLike; nowMs?: number } = {},
): Promise<MapResult<FiledWithProposals>> {
  const subjectItems = isBrandMapScaleEnabled() ? input.items.filter((i) => aboutSubjects(i.change)) : [];
  if (!subjectItems.length) {
    const filed = await fileBrandMapSuggestions(ctx, input, deps);
    return filed.ok ? { ok: true, value: { ...filed.value, proposed: [] } } : filed;
  }
  const moved = await ensureMoved(ctx, deps);
  if (!moved.ok) return moved;
  const read = await readBrandMap(ctx, deps.db);
  const dismissedKeys = new Set(read.state === "ok" ? read.map.dismissed : []);
  const now = new Date(deps.nowMs ?? Date.now()).toISOString();
  const store = brandMapRecords(ctx, deps.db);
  const from: RecordFrom = input.from;
  const proposed: string[] = [];
  const skipped = { inMap: 0, waiting: 0, dismissed: 0 };
  const touched = new Set<string>();
  for (const item of subjectItems) {
    const c = item.change;
    const base = {
      from,
      reason: item.reason,
      evidence: item.ref?.title ? `Suggested by the article “${item.ref.title}”` : "",
      now,
      dismissedKeys,
      revive: Boolean(input.allowDismissed),
    };
    if (c.type === "add_subject") {
      const made = await proposedSubject(ctx, store, { ...base, name: c.name });
      if (made) touched.add(made.id);
      if (made) proposed.push(`Add a subject: “${made.name}”`);
      else skipped.inMap += 1;
    } else if (c.type === "add_question") {
      const subject = await proposedSubject(ctx, store, { ...base, name: c.subject, existingOk: true });
      const made = subject
        ? await proposedQuestion(ctx, store, { ...base, subjectId: subject.id, subjectName: String(subject.name), text: c.text, intent: c.intent, situationIds: input.situationIds })
        : null;
      if (subject) touched.add(subject.id);
      if (made) proposed.push(`Add a question to “${String(subject!.name)}”: “${made.text}”`);
      else skipped.inMap += 1;
    } else if (c.type === "set_home") {
      const [found] = await store.find("sub", { where: [["nameKey", "==", subjectKey(c.name)]], limit: 1 });
      const done = found
        ? await store.claim("sub", found.id, (cur) =>
            cur.home || (typeof cur.suggestedHome === "string" && normalizeUrl(cur.suggestedHome) === normalizeUrl(c.url)) ? null : { suggestedHome: c.url, updatedAt: now },
          )
        : null;
      if (done) proposed.push(`A home page for “${String(found!.name)}”`);
      else skipped.inMap += 1;
    }
  }
  // Proposals get their meaning too, so a later step can place questions in them (best effort).
  await embedSubjects(ctx, [...touched], deps).catch(() => 0);
  const rest = input.items.filter((i) => !aboutSubjects(i.change));
  if (!rest.length && input.research === undefined && !input.replaceOwn) {
    return { ok: true, value: { filed: [], skipped, proposed } };
  }
  const filed = await fileBrandMapSuggestions(ctx, { ...input, items: rest }, deps);
  if (!filed.ok) return filed;
  return {
    ok: true,
    value: {
      filed: filed.value.filed,
      skipped: {
        inMap: filed.value.skipped.inMap + skipped.inMap,
        waiting: filed.value.skipped.waiting + skipped.waiting,
        dismissed: filed.value.skipped.dismissed + skipped.dismissed,
      },
      proposed,
    },
  };
}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import { BrandMapPageFactsSchema } from "@/lib/types/brandMapPage";
import { withDerivedFacts } from "@/lib/content/blog/pageRow";
import { addImported, importReport } from "./importCompare";
import { parsePlaceLines, placeImport } from "./importPlace";
import { getImport, readImport } from "./imports";
import { subjectKey } from "./keys";
import { ensureMoved } from "./move";
import { addQuestion, createGroup, createSubject, listGroups, listSubjects } from "./records";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1", role: "admin" };
const NOW = Date.parse("2026-10-15T10:00:00.000Z");
const PDF = Buffer.from("%PDF-1.7\n% a made-up research file\n");
// No meaning to be had: the nearest subjects come from shared words.
const embed = { embed: async () => [], query: async () => null };

// Made-up research about tracking a brand in AI answers.
const READ = [
  "SEARCH: how to track brand mentions in ai answers | 1",
  "ASK: How often do AI answers change? | 1",
  "ASK: Is brand tracking in AI answers worth it? | 1",
  "ASK: How do I report AI mentions to my board? | 2",
  "ASK: What is the 30% rule for AI at work? | 2",
  "ALSO: how to track brand mentions in ai answers free | 3",
  "ALSO: ai brand tracking tools | 3",
  "ASK: How do I set up prompt tracking for ChatGPT? | 3",
  "THEME: Measuring your AI mentions | 4",
  "THEME: Reporting to leadership | 4",
  "NOTE: Most answers cite the same few sites | 4",
].join("\n");

beforeEach(() => {
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_SCALE_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_IMPORT_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

async function setup() {
  const db = new FakeFirestore();
  const deps = { db, nowMs: NOW, embed };
  await ensureMoved(ctx, deps);
  const g = await createGroup(ctx, { name: "Tracking" }, deps);
  const tracking = await createSubject(ctx, { name: "AI answers tracking", groupId: g.ok ? g.value.id : null }, deps);
  const tid = tracking.ok ? tracking.value.id : "";
  const changes = await addQuestion(ctx, tid, { text: "How often do AI answers change?" }, deps);
  await addQuestion(ctx, tid, { text: "Is brand tracking in AI answers worth the money?" }, deps);
  const imp = await readImport(ctx, { fileName: "research.pdf", bytes: PDF }, { db, nowMs: NOW, modelReady: () => true, read: async () => READ });
  return { db, deps, groupId: g.ok ? g.value.id : "", tid, changesId: changes.ok ? changes.value.id : "", importId: imp.ok ? imp.value.id : "" };
}

/** The model's answer to placing, by the numbers the prompt gave each item, subject and group. */
const placing = (answer: (n: { item: (t: string) => number; subject: (s: string) => string; group: (g: string) => string }) => string[]) =>
  vi.fn(async (prompt: string) => {
    const items = new Map([...prompt.matchAll(/^I(\d+)\. A (?:question|search): (.+?)(?: \(found searching ".*"\))?$/gm)].map((m) => [m[2]!, Number(m[1])]));
    const subjects = new Map([...prompt.matchAll(/^S(\d+)\. (.+)$/gm)].map((m) => [m[2]!, `S${m[1]}`]));
    const groups = new Map([...prompt.matchAll(/^G(\d+)\. (.+)$/gm)].map((m) => [m[2]!, `G${m[1]}`]));
    return answer({ item: (t) => items.get(t) ?? 0, subject: (s) => subjects.get(s) ?? "S99", group: (g) => groups.get(g) ?? "NEW" }).join("\n");
  });

const PLACED = placing(({ item, subject, group }) => [
  `PLACE: I${item("Is brand tracking in AI answers worth it?")} | Is brand tracking in AI answers worth it? | ${subject("AI answers tracking")} | Measuring your AI mentions | none`,
  `PLACE: I${item("How do I report AI mentions to my board?")} | How do I report AI mentions to my board? | NEW: Board reporting | Reporting to leadership | none`,
  `NOFIT: I${item("What is the 30% rule for AI at work?")} | About using AI at work`,
  `PLACE: I${item("how to track brand mentions in ai answers free")} | Can I track brand mentions in AI answers for free? | NEW: Free AI tracking | Measuring your AI mentions | none`,
  `PLACE: I${item("ai brand tracking tools")} | Which AI brand tracking tools are worth using? | NEW: AI tracking tools | Measuring your AI mentions | none`,
  `PLACE: I${item("How do I set up prompt tracking for ChatGPT?")} | How do I set up prompt tracking for ChatGPT? | NEW: board REPORTING | none | none`,
  `THEME: Measuring your AI mentions | NEW`,
  `THEME: Reporting to leadership | ${group("Tracking")}`,
]);

describe("placing a PDF's research on the map", () => {
  it("reads the model's lines, keeping only numbers it was given", () => {
    const lines = parsePlaceLines(
      ["PLACE: I1 | A question? | S2 | Some heading | T1", "PLACE: I1 | Again? | S1 | none | none", "PLACE: I9 | Out of range? | S1 | none | none", "NOFIT: I2 | Not what we do", "THEME: Some heading | G3", "PLACE: I3 | See https://x.example/a | S1 | none | none"].join("\n"),
      { items: 3, subjects: 2, groups: 2, situations: 1 },
    );
    expect(lines).toEqual({
      places: [{ i: 1, question: "A question?", subject: { n: 2 }, theme: "Some heading", situation: 1 }],
      nofit: [{ i: 2, why: "Not what we do" }],
      themes: [{ name: "Some heading", group: null }],
    });
  });

  it("places each item once: on a near subject or a new one, a search as its question, the headings on the groups", async () => {
    const { db, deps, importId, groupId, tid } = await setup();
    const r = await placeImport(ctx, importId, { ...deps, modelReady: () => true, generate: PLACED });
    expect(r).toEqual({ ok: true, value: { done: true, placed: 5, noFit: 1 } });
    // One the map has already, by its words, isn't asked about.
    expect(PLACED.mock.calls[0]![0]).not.toContain("How often do AI answers change?");
    const imp = (await getImport(ctx, importId, { db }))!;
    const by = (t: string) => imp.items.find((i) => i.text === t)!;
    expect(by("Is brand tracking in AI answers worth it?")).toMatchObject({ subjectId: tid, theme: "Measuring your AI mentions", tried: true });
    expect(by("ai brand tracking tools")).toMatchObject({ asQuestion: "Which AI brand tracking tools are worth using?", newSubject: "AI tracking tools" });
    expect(by("What is the 30% rule for AI at work?")).toMatchObject({ fits: false, why: "About using AI at work" });
    expect(imp.themes.map((t) => [t.name, t.groupId])).toEqual([
      ["Measuring your AI mentions", null],
      ["Reporting to leadership", groupId],
    ]);
    expect(imp.placed).toBe(true);
    // Placing adds nothing to the map.
    expect((await listSubjects(ctx, {}, { db })).map((s) => s.name)).toEqual(["AI answers tracking"]);
  });
});

describe("what your research adds", () => {
  it("says what the map answers, has, has close, and what's new and where it would go", async () => {
    const { db, deps, importId, changesId } = await setup();
    await placeImport(ctx, importId, { ...deps, modelReady: () => true, generate: PLACED });
    // A live article answers one of them.
    const facts = withDerivedFacts(BrandMapPageFactsSchema.parse({ kind: "article", workspaceId: "ws1", planId: "p1", title: "How often AI answers change", state: "live", url: "https://acme.example/blog/changes", primaryRef: changesId }));
    db.seed("brand_map_pages", "p_1", { ...facts, id: "p_1", tenantId: "ten_A", fingerprint: "f", updatedAt: "" } as never);
    const tracking = await brandMapRecords(ctx, db).find("sub", { where: [["nameKey", "==", "ai answers tracking"]], limit: 1 });
    await brandMapRecords(ctx, db).claim("sub", tracking[0]!.id, () => ({ answeredIds: [changesId] }));

    const report = await importReport(ctx, (await getImport(ctx, importId, { db }))!, deps);
    const by = (t: string) => report.items.find((i) => i.text === t)!;
    expect(by("How often do AI answers change?")).toMatchObject({ outcome: "answered", answeredBy: { title: "How often AI answers change", url: "https://acme.example/blog/changes" } });
    expect(by("Is brand tracking in AI answers worth it?")).toMatchObject({ outcome: "close", match: { text: "Is brand tracking in AI answers worth the money?" }, addable: true });
    expect(by("How do I report AI mentions to my board?")).toMatchObject({ outcome: "new", newSubject: "Board reporting", addable: true });
    expect(by("What is the 30% rule for AI at work?")).toMatchObject({ outcome: "no_fit", why: "About using AI at work" });
    expect(by("how to track brand mentions in ai answers free")).toMatchObject({ outcome: "new", question: "Can I track brand mentions in AI answers for free?", adds: "free" });
    expect(report.counts).toMatchObject({ found: 7, newQuestions: 4, newSubjects: 3, newGroups: 1, answered: 1, close: 1, noFit: 1, searches: 2 });
    expect(report.themes).toEqual([
      { name: "Measuring your AI mentions", page: 4, groupId: null, groupName: "", newSubjects: ["Free AI tracking", "AI tracking tools"], becomesGroup: true },
      { name: "Reporting to leadership", page: 4, groupId: expect.any(String), groupName: "Tracking", newSubjects: ["Board reporting"], becomesGroup: false },
    ]);
    expect(report.adds).toEqual(["free"]);
  });

  it("adds what's ticked: new subjects (a heading with two becomes a group), decided questions marked with where they came from, and leads", async () => {
    const { db, deps, importId, groupId } = await setup();
    await placeImport(ctx, importId, { ...deps, modelReady: () => true, generate: PLACED });
    const before = await importReport(ctx, (await getImport(ctx, importId, { db }))!, deps);
    const ticked = before.items.filter((i) => i.outcome === "new").map((i) => i.id);
    const r = await addImported(ctx, importId, ticked, deps);
    expect(r).toEqual({ ok: true, value: { added: 4, newSubjects: 3, newGroups: 1 } });

    const groups = await listGroups(ctx, { db });
    const measuring = groups.find((g) => g.name === "Measuring your AI mentions")!;
    expect(measuring.status).toBe("decided");
    const subjects = await listSubjects(ctx, {}, { db });
    const place = (name: string) => subjects.find((s) => s.name === name)?.groupId;
    expect(place("Free AI tracking")).toBe(measuring.id);
    expect(place("AI tracking tools")).toBe(measuring.id);
    // Its heading sits on a group the map has: the new subject goes there.
    expect(place("Board reporting")).toBe(groupId);
    const [free] = await brandMapRecords(ctx, db).find("q", { where: [["textKey", "==", "can i track brand mentions in ai answers for free"]], limit: 1 });
    expect(free).toMatchObject({ status: "decided", from: "import", evidence: "From your research: research.pdf, page 3", leads: ["free"] });

    // Reopened, the report follows the map: the four are on it now (with the one it had), not new.
    const after = await importReport(ctx, (await getImport(ctx, importId, { db }))!, deps);
    expect(after.counts).toMatchObject({ newQuestions: 0, onMap: 5 });
  });

  it("adding a question to a subject research only proposed adds the subject too", async () => {
    const { db, deps, importId } = await setup();
    // Proposed a moment ago; nobody has added it yet.
    const store = brandMapRecords(ctx, db);
    await store.create("sub", "sub_proposed", { status: "proposed", from: "research", name: "Board reporting", nameKey: subjectKey("Board reporting"), groupId: null, rev: 0, createdAt: "", updatedAt: "" });
    await placeImport(ctx, importId, { ...deps, modelReady: () => true, generate: PLACED });
    const report = await importReport(ctx, (await getImport(ctx, importId, { db }))!, deps);
    const board = report.items.find((i) => i.question === "How do I report AI mentions to my board?")!;
    expect(board).toMatchObject({ outcome: "new", addable: true });
    expect((await addImported(ctx, importId, [board.id], deps)).ok).toBe(true);
    expect((await store.get("sub", "sub_proposed"))?.status).toBe("decided");
    expect(await store.find("q", { where: [["subjectId", "==", "sub_proposed"]] })).toMatchObject([{ status: "decided", text: "How do I report AI mentions to my board?" }]);
  });
});

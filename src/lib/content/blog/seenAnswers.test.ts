import { describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { askQuestions, createNote, getNote } from "@/lib/brandNotes/store";
import { answerForArticle } from "./seenAnswers";

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_member" };
const B: TenantContext = { tenantId: "ten_B", region: "us", source: "idtoken", userId: "usr_b" };
const article = { ref: "ws_1/plan_1", title: "How often to check" };

function deps() {
  return { db: new FakeFirestore(), embed: vi.fn(async (items: unknown[]) => items.map(() => [0.1])) };
}

describe("an answer saved from an article", () => {
  it("answers a question that article asked, linking it to the article's subject", async () => {
    const d = deps();
    const [q] = await askQuestions(A, { questions: ["What did you test first?"], article }, d);
    const r = await answerForArticle(A, { article: "ws_1/plan_1", subjectId: "sub_1", body: { noteId: q!.id, text: "We ran the same question every day for a week." } }, d);
    expect(r).toEqual({
      status: 200,
      body: { question: { id: q!.id, question: "What did you test first?", answer: "We ran the same question every day for a week.", status: "kept" } },
    });
    expect(await getNote(A, q!.id, d)).toMatchObject({ subjectIds: ["sub_1"], answeredBy: "usr_member" });
  });

  it("refuses a question another article asked, any other note, another brand's, and bad input", async () => {
    const d = deps();
    const [q] = await askQuestions(A, { questions: ["What did you test first?"], article }, d);
    const typed = await createNote(A, { text: "A note typed on the page.", kind: "tested", subjectIds: [], canName: false }, { source: "typed" }, d);
    if (!typed.ok) throw new Error("not made");
    const text = "We ran the same question every day for a week.";
    expect((await answerForArticle(A, { article: "ws_1/plan_2", subjectId: null, body: { noteId: q!.id, text } }, d)).status).toBe(403);
    expect((await answerForArticle(A, { article: "ws_1/plan_1", subjectId: null, body: { noteId: typed.value.id, text } }, d)).status).toBe(403);
    expect((await answerForArticle(B, { article: "ws_1/plan_1", subjectId: null, body: { noteId: q!.id, text } }, d)).status).toBe(404);
    expect((await answerForArticle(A, { article: "ws_1/plan_1", subjectId: null, body: { noteId: "../x", text } }, d)).status).toBe(400);
    expect((await answerForArticle(A, { article: "ws_1/plan_1", subjectId: null, body: { noteId: q!.id, text: "x".repeat(1201) } }, d)).status).toBe(400);
    expect((await getNote(A, typed.value.id, d))?.text).toBe("A note typed on the page.");
  });
});

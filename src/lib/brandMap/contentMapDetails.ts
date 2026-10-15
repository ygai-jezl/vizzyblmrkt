import type { CoveragePage, QuestionState } from "@/lib/content/blog/coverage";
import { normalizeUrl } from "@/lib/content/blog/brief";
import { UNPLACED, type ContentMapInput, type MapPage, type MapPoint, type PointState } from "./contentMapLayout";

/**
 * What the content map's details panel says about a point, worked out apart from how it is
 * drawn. Pure + client-safe.
 */

export const QUESTION_STATE_LABEL: Record<QuestionState, string> = { answered: "Answered", drafted: "Drafted", planned: "Planned", open: "Open" };
export const POINT_LABEL: Record<PointState, string> = {
  live: "Live article",
  approved: "Approved",
  draft: "Draft",
  planned: "Planned",
  open: "Question not written yet",
};

/** Where a page opens: an article's plan in the app, or the page itself. */
export function pageHref(p: Pick<CoveragePage, "kind" | "workspaceId" | "planId" | "url">): string | null {
  if (p.kind === "article" && p.workspaceId && p.planId) {
    return `/admin/workspace/${encodeURIComponent(p.workspaceId)}/create/${encodeURIComponent(p.planId)}`;
  }
  return p.url && /^https:\/\//i.test(p.url) ? p.url : null;
}

export interface DetailsList {
  head: string;
  items: string[];
  /** Said when there are none; without it, an empty list is left out. */
  empty?: string;
}

export interface DetailsView {
  kicker: string;
  title: string;
  /** A line under the title. */
  text?: string;
  badge?: string;
  lists: DetailsList[];
  notes: Array<{ tone: "info" | "warn"; text: string }>;
  /** Open the article; view the page; write the question; show only this subject. */
  actions: { open?: string; view?: string; writeNext?: string; showSubject?: string };
}

const titleOf = (p: Pick<MapPage, "title" | "url">) => p.title || p.url || "Untitled";

export function pointDetails(point: MapPoint, input: ContentMapInput): DetailsView {
  const { coverage } = input;

  if (point.kind === "brand") {
    return {
      kicker: "Your brand",
      title: input.brand.name || "Your brand",
      ...(input.brand.statement ? { text: input.brand.statement } : {}),
      lists: [{ head: "Subjects", items: coverage.subjects.map((s) => `${s.name} · ${s.answered} of ${s.questions.length} answered`), empty: "No subjects yet." }],
      notes: [{ tone: "info", text: "Click any point to see what it is." }],
      actions: {},
    };
  }

  if (point.kind === "area" || point.kind === "more") {
    const s = coverage.subjects.find((x) => x.id === point.ref);
    if (!s || point.ref === UNPLACED) {
      return {
        kicker: "Unplaced",
        title: "Pages on no subject",
        text: "They answer none of your map's questions and were written for no subject. Give an article a subject in its brief, or add the question it answers to a subject.",
        lists: [],
        notes: point.kind === "more" ? [{ tone: "info", text: `${point.count} more pages are not shown, to keep the map readable.` }] : [],
        actions: {},
      };
    }
    return {
      kicker: "Subject",
      title: s.name,
      badge: `${s.answered} of ${s.questions.length} answered`,
      lists: [{ head: "Questions", items: s.questions.map((q) => `${QUESTION_STATE_LABEL[q.state]}: ${q.text}`), empty: "No questions yet." }],
      notes: point.kind === "more" ? [{ tone: "info", text: `${point.count} more pages are not shown, to keep the map readable.` }] : [],
      actions: { showSubject: s.id },
    };
  }

  if (point.kind === "question") {
    const s = coverage.subjects.find((x) => x.questions.some((q) => q.id === point.ref));
    const q = s?.questions.find((x) => x.id === point.ref);
    return {
      kicker: "Question not written yet",
      title: point.title,
      lists: [...(s ? [{ head: "Subject", items: [s.name] }] : []), ...(q?.probably ? [{ head: "Probably answered by", items: [q.probably.title] }] : [])],
      notes: [],
      actions: { writeNext: point.ref },
    };
  }

  const page = input.pages.find((p) => p.id === point.ref);
  if (!page) return { kicker: "", title: point.title, lists: [], notes: [], actions: {} };
  const byUrl = new Map(input.pages.flatMap((p) => (p.url ? [[normalizeUrl(p.url), p] as const] : [])));
  const self = page.url ? normalizeUrl(page.url) : "";
  const answers = coverage.subjects.flatMap((s) => s.questions.filter((q) => q.pages.some((p) => p.id === page.id)).map((q) => q.text));
  const linksTo = [...new Set(page.links.map(normalizeUrl))].flatMap((u) => {
    const to = byUrl.get(u);
    return to && to.id !== page.id ? [titleOf(to)] : [];
  });
  const linkedFrom = self ? input.pages.filter((p) => p.id !== page.id && p.links.some((l) => normalizeUrl(l) === self)).map(titleOf) : [];
  const shouldLinkHere = coverage.missingLinks.filter((m) => m.to.id === page.id).map((m) => m.from.title);
  const shouldLinkTo = coverage.missingLinks.filter((m) => m.from.id === page.id).map((m) => m.to.title);
  const twin = coverage.overlaps.find((o) => o.pages.some((p) => p.id === page.id));
  const homeFor = self ? input.homes.filter((h) => normalizeUrl(h.url) === self).map((h) => h.label) : [];
  const article = page.kind === "article";
  const viewable = page.url && /^https:\/\//i.test(page.url) && (!article || page.state === "live") ? page.url : undefined;
  const open = article ? pageHref(page) : null;

  const lists: DetailsList[] = [
    ...(homeFor.length ? [{ head: "Home page for", items: homeFor }] : []),
    ...(article ? [{ head: "Answers", items: answers, empty: "None of your map's questions yet." }] : answers.length ? [{ head: "Answers", items: answers }] : []),
    ...(article ? [{ head: "Address", items: page.url ? [page.url] : [], empty: "No address yet." }] : []),
    ...(page.names.length ? [{ head: "Names it uses", items: [page.names.join(", ")] }] : []),
    { head: "Links to", items: linksTo, ...(page.linksKnown ? { empty: "None of the pages on the map." } : {}) },
    { head: "Linked from", items: linkedFrom, empty: "Nothing on the map links here yet." },
    ...(shouldLinkHere.length ? [{ head: "Should link here", items: shouldLinkHere }] : []),
    ...(shouldLinkTo.length ? [{ head: "Should link to", items: shouldLinkTo }] : []),
  ];
  const notes: DetailsView["notes"] = [
    ...(page.linksKnown ? [] : [{ tone: "info" as const, text: "Its links haven't been read yet. They are the next time your site is read." }]),
    ...(twin
      ? [{ tone: "warn" as const, text: `Answers the same main question as ${twin.pages.filter((p) => p.id !== page.id).map((p) => `“${p.title}”`).join(", ")}.` }]
      : []),
  ];
  return {
    kicker: article ? POINT_LABEL[page.state] : "Page on your site",
    title: titleOf(page),
    ...(article && page.primaryQuestion ? { text: page.primaryQuestion } : {}),
    lists,
    notes,
    actions: { ...(open ? { open } : {}), ...(viewable ? { view: viewable } : {}) },
  };
}

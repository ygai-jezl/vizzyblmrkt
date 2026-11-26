import type { Campaign } from "@/lib/types/campaign";
import type { Company } from "@/lib/types/company";
import type { PersonProductLink } from "@/lib/types/contact";
import type { ProductConnection } from "@/lib/types/productConnection";
import type { ProductUser } from "@/lib/types/productUser";
import type { Signup } from "@/lib/types/signup";
import { voiceChatDone } from "@/lib/waitlist/voiceChat";

/**
 * Fields from elsewhere (piece B, AUDIENCE_FIELDS_ENABLED): shown beside the brand's own fields,
 * read only, worked out when shown and never stored, with no history. Pure.
 *
 * - Sign-up answers, from each of the person's sign-ups, labelled with their launch. Questions
 *   are keyed by their text, which can be edited, so they stay display only.
 * - A connected product's stage, traits and facts, from the person's product users and the
 *   product's catalog.
 * - Company enrichment.
 * - The voice chat on a sign-up page: its summary, which the person's browser sent and nobody has
 *   checked. The conversation itself is served only to admins (its own route), never here.
 */

/** What the Data model shows for a field from elsewhere. */
export interface ReadOnlyFieldDef {
  /** Stable within the page, for lists. */
  key: string;
  label: string;
  typeLabel: string;
  /** Where it comes from, in words: "Sign-up answer · Spring launch", "Acme App fact". */
  source: string;
  /** Whether the People list can filter by it, or find it by search. */
  inFilters: "Yes" | "No" | "Search";
}

/** One value from elsewhere on a person's or company's page. */
export interface ReadOnlyValue {
  key: string;
  label: string;
  /** The value in words; a time is ISO, for the page to show in the viewer's time zone. */
  value: string;
  kind?: "time";
  source: string;
}

/** A completed voice chat on a sign-up page, without what was said. */
export interface VoiceChatSummary {
  signupId: string;
  launchName: string;
  /** What the person's browser sent when the chat ended. Unchecked. */
  summary: string | null;
  at: string;
  turns: number;
}

type NamedConnection = Pick<ProductConnection, "id" | "catalog"> & { name: string };

const TRAIT_TYPE: Record<string, string> = { string: "text", number: "number", boolean: "checkbox", timestamp: "date" };
const FACT_TYPE: Record<string, string> = { string: "text", number: "number", boolean: "checkbox", date: "date" };
const STAGE_WORD: Record<PersonProductLink["stage"], string> = { new: "New", onboarding: "Onboarding", stuck: "Stuck", activated: "Activated", member: "Using the product" };

/** "11-50" as "11 to 50", so a range never reads as punctuation. */
function rangeWords(v: string): string {
  return v.replace(/^(\d[\d,]*)\s*-\s*(\d[\d,]*)$/, "$1 to $2");
}

/** Company enrichment, as the Companies object shows it: label and the profile's value. */
function companyProfileValues(company: Pick<Company, "domain" | "profile">): Array<{ key: string; label: string; value: string | null }> {
  const p = company.profile ?? {};
  return [
    { key: "industry", label: "Industry", value: p.industry ?? null },
    { key: "size", label: "Company size", value: p.employeeRange ? rangeWords(p.employeeRange) : null },
    { key: "location", label: "Location", value: p.hqLocation ?? p.country ?? null },
    { key: "founded", label: "Founded", value: p.foundedYear != null ? String(p.foundedYear) : null },
    { key: "funding", label: "Funding stage", value: p.fundingStage ?? null },
    { key: "website", label: "Website", value: p.website ?? null },
  ];
}

/**
 * The fields from elsewhere a brand has, for Settings › Data model: from its launches' questions,
 * its products' catalogs, enrichment and its launches' voice chats. `ideas` (isIdeaWordsEnabled())
 * names an unnamed launch an idea.
 */
export function readOnlyFieldDefs(
  object: "person" | "company",
  sources: { campaigns: ReadonlyArray<Pick<Campaign, "id" | "waitlistName" | "questions" | "aiConversation">>; connections: readonly NamedConnection[] },
  opts: { ideas?: boolean } = {},
): ReadOnlyFieldDef[] {
  if (object === "company") {
    return [
      { key: "domain", label: "Name and web address", typeLabel: "text", source: "YouGrow", inFilters: "Search" },
      ...companyProfileValues({ domain: "", profile: null }).map((f) => ({ key: `company:${f.key}`, label: f.label, typeLabel: "text", source: "Company enrichment", inFilters: "No" as const })),
    ];
  }
  const out: ReadOnlyFieldDef[] = [{ key: "identity", label: "Name, email, phone", typeLabel: "text", source: "YouGrow", inFilters: "Search" }];
  for (const c of sources.campaigns) {
    (c.questions ?? []).forEach((q, i) => {
      if (!q.question_value?.trim()) return;
      out.push({ key: `answer:${c.id}:${i}`, label: q.question_value.trim(), typeLabel: "text", source: `Sign-up answer · ${c.waitlistName || (opts.ideas ? "An idea" : "A launch")}`, inFilters: "No" });
    });
  }
  for (const c of sources.connections) {
    out.push({ key: `stage:${c.id}`, label: "Stage", typeLabel: "status", source: c.name, inFilters: "Yes" });
    for (const t of c.catalog?.traits ?? []) {
      out.push({ key: `trait:${c.id}:${t.key}`, label: t.label || t.key, typeLabel: TRAIT_TYPE[t.type] ?? "text", source: `${c.name} trait`, inFilters: "No" });
    }
    for (const f of c.catalog?.facts ?? []) {
      if (f.kind) continue; // a fact per workspace or brand belongs to the group, not the person
      out.push({ key: `fact:${c.id}:${f.id}`, label: f.label, typeLabel: FACT_TYPE[f.type] ?? "number", source: `${c.name} fact`, inFilters: "No" });
    }
  }
  out.push({ key: "company:size", label: "Company size", typeLabel: "text", source: "Company enrichment", inFilters: "No" });
  if (sources.campaigns.some((c) => c.aiConversation?.enabled)) {
    out.push({ key: "voice", label: "Voice chat", typeLabel: "text", source: "Sign-up voice chat", inFilters: "No" });
  }
  return out;
}

function words(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v);
}

/**
 * A person's fields from elsewhere, and their voice chats: answers from each sign-up, each
 * product's stage, traits and facts, and their company's size.
 */
export function personReadOnly(input: {
  signups: ReadonlyArray<{ signup: Pick<Signup, "id" | "answers" | "aiConversation">; launchName: string }>;
  products: ReadonlyArray<Pick<PersonProductLink, "connectionId" | "productUserId" | "stage">>;
  users: ReadonlyArray<Pick<ProductUser, "id" | "traits" | "facts">>;
  connections: ReadonlyMap<string, NamedConnection>;
  company: Pick<Company, "domain" | "profile"> | null;
}): { values: ReadOnlyValue[]; voiceChats: VoiceChatSummary[] } {
  const values: ReadOnlyValue[] = [];
  const voiceChats: VoiceChatSummary[] = [];
  for (const { signup, launchName } of input.signups) {
    (signup.answers ?? []).forEach((a, i) => {
      const answer = a.answer_value?.trim();
      if (!a.question_value?.trim() || !answer) return;
      values.push({ key: `answer:${signup.id}:${i}`, label: a.question_value.trim(), value: answer, source: `Sign-up answer · ${launchName}` });
    });
    const chat = signup.aiConversation;
    if (chat && voiceChatDone(chat)) {
      voiceChats.push({ signupId: signup.id, launchName, summary: chat.summary?.trim() || null, at: chat.capturedAt, turns: chat.transcript?.length ?? 0 });
    }
  }
  const users = new Map(input.users.map((u) => [u.id, u]));
  for (const p of input.products) {
    const c = input.connections.get(p.connectionId);
    const name = c?.name ?? "A product";
    values.push({ key: `stage:${p.productUserId}`, label: "Stage", value: STAGE_WORD[p.stage], source: name });
    const u = users.get(p.productUserId);
    if (!u || !c) continue;
    for (const t of c.catalog?.traits ?? []) {
      const v = words(u.traits?.[t.key]);
      if (v !== null) values.push({ key: `trait:${u.id}:${t.key}`, label: t.label || t.key, value: v, ...(t.type === "timestamp" ? { kind: "time" as const } : {}), source: `${name} trait` });
    }
    for (const f of c.catalog?.facts ?? []) {
      if (f.kind) continue;
      const v = words(u.facts?.[f.id]?.value);
      if (v !== null) values.push({ key: `fact:${u.id}:${f.id}`, label: f.label, value: f.unit ? `${v} ${f.unit}` : v, source: `${name} fact` });
    }
  }
  const size = input.company?.profile?.employeeRange;
  if (size) values.push({ key: "company:size", label: "Company size", value: rangeWords(size), source: "Company enrichment" });
  return { values, voiceChats: voiceChats.sort((a, b) => b.at.localeCompare(a.at)) };
}

/** A company's fields from enrichment, the ones it has. */
export function companyReadOnly(company: Pick<Company, "domain" | "profile">): ReadOnlyValue[] {
  return companyProfileValues(company)
    .filter((f): f is { key: string; label: string; value: string } => !!f.value)
    .map((f) => ({ key: `company:${f.key}`, label: f.label, value: f.value, source: "Company enrichment" }));
}

import { createHash } from "node:crypto";

/**
 * Fingerprints for the agent record (ADR-0026): 16 hex of a hash over what matters in a draft, so
 * "kept after a person's edits" is a comparison of two fingerprints and the record never holds the
 * draft's words. Each covers what a person would call a change (subjects, bodies, waits, the start,
 * a style's colours) and never positions or generated ids, so opening a draft and saving it with no
 * change keeps its fingerprint.
 */

/** JSON with object keys sorted and undefined dropped, so the same value always prints the same. */
export function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableJson(v)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}

/** 16 hex of a sha256. */
export function hash16(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** A value's fingerprint. */
export function fingerprintOf(value: unknown): string {
  return hash16(stableJson(value));
}

/** Text as compared: trimmed, with runs of spaces as one, so a stray space is no edit. */
const text = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();

// --- Each kind of draft ---------------------------------------------------------------------------

interface LaunchJourneyLike {
  nodes: ReadonlyArray<{ type: string; data?: { subject?: string; body?: string; waitHours?: number; abTest?: { variants?: ReadonlyArray<{ subject: string; body: string }> } } }>;
}

/** A launch's welcome journey on the original engine: each email (and its test variants) and each wait. */
export function launchJourneyPrint(graph: LaunchJourneyLike): string {
  return fingerprintOf(
    graph.nodes.flatMap((n): unknown[] => {
      if (n.type === "email") {
        return [["email", text(n.data?.subject), text(n.data?.body), (n.data?.abTest?.variants ?? []).map((v) => [text(v.subject), text(v.body)])]];
      }
      if (n.type === "wait") return [["wait", n.data?.waitHours ?? 0]];
      return [];
    }),
  );
}

interface LifecycleDraftLike {
  graph: { nodes: ReadonlyArray<{ type: string; data?: { wait?: unknown } }> };
  pools: ReadonlyArray<{ items: ReadonlyArray<{ subject: string; body: string }> }>;
  settings: { trigger?: unknown; emailStyle?: unknown };
}

/** A lifecycle journey's draft: each email's subject and body, each wait, the start and its own email style. */
export function lifecycleDraftPrint(draft: LifecycleDraftLike): string {
  return fingerprintOf({
    emails: draft.pools.map((p) => p.items.map((i) => [text(i.subject), text(i.body)])),
    waits: draft.graph.nodes.filter((n) => n.type === "wait").map((n) => n.data?.wait ?? null),
    start: draft.settings.trigger ?? null,
    style: draft.settings.emailStyle ?? null,
  });
}

/** An invite wave: how many people, and its email. */
export function wavePrint(wave: { size: number; subject: string; body: string }): string {
  return fingerprintOf({ size: wave.size, subject: text(wave.subject), body: text(wave.body) });
}

/** A content plan: each piece's role and body. */
export function planPrint(plan: { graph?: { nodes?: ReadonlyArray<{ type: string; role?: string; body?: string }> } }): string {
  return fingerprintOf((plan.graph?.nodes ?? []).map((n) => [n.type, text(n.role), text(n.body)]));
}

/** An email style as suggested or as saved: the logo, name, colours, header and theme. */
export interface EmailStyleLike {
  logoId?: string | null;
  logo?: { id: string } | null;
  companyName?: string | null;
  headerColor: string;
  accentColor: string;
  headerGradientColor?: string | null;
  headerText?: string | null;
  headerImageId?: string | null;
  headerImage?: { id: string } | null;
  theme?: { preset: string; headingFont?: string; bodyFont?: string } | null;
}

export function emailStylePrint(s: EmailStyleLike): string {
  const header = s.headerColor.toLowerCase();
  const gradient = s.headerGradientColor?.toLowerCase() ?? null;
  const theme = s.theme && !(s.theme.preset === "classic" && !s.theme.headingFont && !s.theme.bodyFont) ? s.theme : null;
  return fingerprintOf({
    logo: s.logoId ?? s.logo?.id ?? null,
    name: s.companyName ?? null,
    header,
    accent: s.accentColor.toLowerCase(),
    gradient: gradient && gradient !== header ? gradient : null,
    text: s.headerText && s.headerText !== "auto" ? s.headerText : null,
    image: s.headerImageId ?? s.headerImage?.id ?? null,
    theme,
  });
}

/** An image style as suggested or as saved: the default style and each channel's. */
export function imageStylePrint(s: { defaultStyleId: string | null; channels?: Record<string, string | null | undefined> | null }): string {
  const channels = Object.fromEntries(Object.entries(s.channels ?? {}).filter(([, v]) => !!v));
  return fingerprintOf({ default: s.defaultStyleId ?? null, channels });
}

/** A note: its text. */
export function notePrint(note: { text: string }): string {
  return fingerprintOf(text(note.text));
}

/** A brand map key (a suggestion's changeKey), hashed: it can hold a name, so it is never stored. */
export function keyHash(key: string): string {
  return hash16(`key\n${key}`);
}

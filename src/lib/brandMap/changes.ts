import {
  BRAND_MAP_LIMITS as LIMITS,
  BrandMapDecidedSchema,
  type BrandMapChange,
  type BrandMapDecided,
  type BrandMapName,
  type BrandMapNameKind,
  type BrandMapSubject,
} from "@/lib/types/brandMap";
import { hostOf, normalizeUrl } from "@/lib/content/blog/brief";

/**
 * What a suggested change is, what it would do to the decided half of a brand map, and how
 * to say it in plain words. Shared by the page (accepting a suggestion), the store (filing
 * and resolving suggestions) and Vizzy's summary. Pure + client-safe.
 */

/** Letters and digits of any script, lower case, one space between words: two spellings of one name compare equal. */
export function fold(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** A fresh id for a subject, question, name or suggestion: made once, never reused. */
export function newId(prefix: "sub" | "q" | "n" | "sg"): string {
  const raw =
    globalThis.crypto && typeof globalThis.crypto.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${raw.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 12)}`;
}

export function emptyDecided(): BrandMapDecided {
  return BrandMapDecidedSchema.parse({});
}

/** The same proposal always has the same key, however it is spelled, so it is filed once and a dismissal sticks. */
export function changeKey(c: BrandMapChange): string {
  const key = (() => {
    switch (c.type) {
      case "set_identity":
        return `identity:${c.field}:${c.field === "site" ? normalizeUrl(c.value) : fold(c.value)}`;
      case "add_is_not":
        return `isnot:${fold(c.text)}`;
      case "add_avoid":
        return `avoid:${fold(c.term)}`;
      case "add_profile":
        return `profile:${normalizeUrl(c.url)}`;
      case "add_subject":
        return `subject:${fold(c.name)}`;
      case "add_question":
        return `q:${fold(c.subject)}:${fold(c.text)}`;
      case "add_name":
        return `name:${fold(c.name)}`;
      case "add_alias":
        return `alias:${fold(c.name)}:${fold(c.alias)}`;
      case "set_home":
        return `home:${c.target}:${fold(c.name)}:${normalizeUrl(c.url)}`;
    }
  })();
  return key.slice(0, 200);
}

/** A name on the map, by its name or one of its other spellings. */
export function findName(d: BrandMapDecided, name: string): BrandMapName | undefined {
  const k = fold(name);
  if (!k) return undefined;
  return d.names.find((n) => fold(n.name) === k || n.aliases.some((a) => fold(a) === k));
}

export function findSubject(d: BrandMapDecided, name: string): BrandMapSubject | undefined {
  const k = fold(name);
  if (!k) return undefined;
  return d.subjects.find((s) => fold(s.name) === k);
}

const sameUrl = (a: string | null | undefined, b: string | null | undefined) => Boolean(a && b && normalizeUrl(a) === normalizeUrl(b));

/** Already true of the map: nothing to suggest, and nothing to apply. */
export function isSatisfied(d: BrandMapDecided, c: BrandMapChange): boolean {
  switch (c.type) {
    case "set_identity":
      return c.field === "site" ? sameUrl(d.identity.site, c.value) : fold(d.identity[c.field]) === fold(c.value);
    case "add_is_not":
      return d.identity.isNot.some((t) => fold(t) === fold(c.text));
    case "add_avoid":
      return d.identity.avoid.some((a) => fold(a.term) === fold(c.term));
    case "add_profile":
      return d.identity.profiles.some((p) => sameUrl(p.url, c.url));
    case "add_subject":
      return Boolean(findSubject(d, c.name));
    case "add_question": {
      const subject = findSubject(d, c.subject);
      return Boolean(subject?.questions.some((q) => fold(q.text) === fold(c.text)));
    }
    case "add_name":
      return Boolean(findName(d, c.name));
    case "add_alias": {
      const name = findName(d, c.name);
      return Boolean(name && (fold(name.name) === fold(c.alias) || name.aliases.some((a) => fold(a) === fold(c.alias))));
    }
    case "set_home": {
      const target = c.target === "subject" ? findSubject(d, c.name) : findName(d, c.name);
      return Boolean(target && sameUrl(target.home, c.url));
    }
  }
}

export interface Applied {
  decided: BrandMapDecided;
  /** Why it could not be applied ("" = it was, or there was nothing to do). */
  issue: string;
}

/**
 * Apply one change to a copy of the decided half. Never throws: a change that cannot be
 * applied (a list is full, the name it adds a spelling to is gone) comes back with the map
 * unchanged and the reason.
 */
export function applyChange(d: BrandMapDecided, c: BrandMapChange, ids: (p: "sub" | "q" | "n") => string = newId): Applied {
  if (isSatisfied(d, c)) return { decided: d, issue: "" };
  const next: BrandMapDecided = structuredClone(d);
  const full = (what: string) => ({ decided: d, issue: `${what} is full` });
  switch (c.type) {
    case "set_identity": {
      if (c.field === "site") {
        if (!/^https:\/\//i.test(c.value)) return { decided: d, issue: "the site must be an https address" };
        next.identity.site = c.value.slice(0, 300);
      } else {
        const max = c.field === "statement" ? LIMITS.statement : c.field === "name" ? LIMITS.name : LIMITS.category;
        next.identity[c.field] = c.value.slice(0, max);
      }
      break;
    }
    case "add_is_not":
      if (next.identity.isNot.length >= LIMITS.isNot) return full("What you are not");
      next.identity.isNot.push(c.text);
      break;
    case "add_avoid":
      if (next.identity.avoid.length >= LIMITS.avoid) return full("Names to avoid");
      next.identity.avoid.push({ term: c.term, useInstead: c.useInstead });
      break;
    case "add_profile":
      if (next.identity.profiles.length >= LIMITS.profiles) return full("Profile links");
      next.identity.profiles.push({ url: c.url, source: c.source, confirmedAt: "" });
      break;
    case "add_subject":
      if (next.subjects.length >= LIMITS.subjects) return full("Subjects");
      next.subjects.push({ id: ids("sub"), name: c.name, questions: [] });
      break;
    case "add_question": {
      let subject = findSubject(next, c.subject);
      if (!subject) {
        // A question arrives before its subject was accepted: the subject comes with it.
        if (next.subjects.length >= LIMITS.subjects) return full("Subjects");
        subject = { id: ids("sub"), name: c.subject, questions: [] };
        next.subjects.push(subject);
      }
      if (subject.questions.length >= LIMITS.questions) return full(`${subject.name}'s questions`);
      subject.questions.push({ id: ids("q"), text: c.text, intent: c.intent });
      break;
    }
    case "add_name":
      if (next.names.length >= LIMITS.names) return full("Names");
      next.names.push({ id: ids("n"), name: c.name, kind: c.kind, aliases: c.aliases.slice(0, LIMITS.aliases), sameAs: [] });
      break;
    case "add_alias": {
      const name = findName(next, c.name);
      if (!name) return { decided: d, issue: `“${c.name}” is not on the map` };
      if (name.aliases.length >= LIMITS.aliases) return full(`${name.name}'s other spellings`);
      name.aliases.push(c.alias);
      break;
    }
    case "set_home": {
      const target = c.target === "subject" ? findSubject(next, c.name) : findName(next, c.name);
      if (!target) return { decided: d, issue: `“${c.name}” is not on the map` };
      target.home = c.url;
      break;
    }
  }
  return { decided: next, issue: "" };
}

/** Apply several changes in order (a subject before its questions). */
export function applyChanges(
  d: BrandMapDecided,
  changes: BrandMapChange[],
  ids?: (p: "sub" | "q" | "n") => string,
): { decided: BrandMapDecided; issues: string[] } {
  let decided = d;
  const issues: string[] = [];
  for (const c of changes) {
    const r = applyChange(decided, c, ids);
    decided = r.decided;
    if (r.issue) issues.push(r.issue);
  }
  return { decided, issues };
}

export const NAME_KIND_LABEL: Record<BrandMapNameKind, string> = {
  product: "a product",
  alternative: "an alternative",
  integration: "an integration",
  audience: "who it is for",
  use_case: "a use case",
};

/** Products, Alternatives… — the headings on the page. */
export const NAME_KIND_HEADING: Record<BrandMapNameKind, string> = {
  product: "Products",
  alternative: "Alternatives",
  integration: "Integrations",
  audience: "Who it is for",
  use_case: "Use cases",
};

const shortUrl = (url: string) => {
  try {
    const u = new URL(url);
    return `${hostOf(url)}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url;
  }
};

/** The change in plain words, as the page and Vizzy say it. */
export function describeChange(c: BrandMapChange): string {
  switch (c.type) {
    case "set_identity":
      return c.field === "name"
        ? `Call the brand “${c.value}”`
        : c.field === "category"
          ? `Call your category “${c.value}”`
          : c.field === "statement"
            ? `Say what you are as: “${c.value}”`
            : `Your site is ${shortUrl(c.value)}`;
    case "add_is_not":
      return `Add to what you are not: “${c.text}”`;
    case "add_avoid":
      return c.useInstead ? `Avoid “${c.term}”. Say “${c.useInstead}”.` : `Avoid “${c.term}”.`;
    case "add_profile":
      return `Add a profile link: ${shortUrl(c.url)}`;
    case "add_subject":
      return `Add a subject: “${c.name}”`;
    case "add_question":
      return `Add a question to ${c.subject}: “${c.text}”`;
    case "add_name":
      return `Add ${c.name} as ${NAME_KIND_LABEL[c.kind]}`;
    case "add_alias":
      return `Add “${c.alias}” as another spelling of ${c.name}`;
    case "set_home":
      return `Make ${shortUrl(c.url)} the page for ${c.name}`;
  }
}

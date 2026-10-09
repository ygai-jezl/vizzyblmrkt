import type { ProductUser } from "@/lib/types/productUser";

/**
 * Taking a person out of a string, for whatever leaves the app about them: Vizzy's
 * brief (personBrief.ts) and the plan that steers their AI line (personPlans.ts).
 * Pure.
 */

/** Anything shaped like an email address, in any script, with its "@" typed or URL-encoded. */
const EMAIL_LIKE = /[\p{L}\p{N}._%+-]+(?:@|%40)[\p{L}\p{N}.-]+\.\p{L}{2,}/giu;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A run of letters, marks and digits: a word, in any script. */
const WORD = /[\p{L}\p{M}\p{N}]+/gu;
/** What may sit between two parts of a name: "Jo Okafor", "Okafor, Jo", "jo.okafor". */
const BETWEEN = /^[\s.,_'’-]{1,3}$/;
/** Scripts written without spaces, where a name is found inside a run of text, not as a word of its own. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
/** Letters that are one letter with a mark in all but encoding. */
const UNMARKED: Record<string, string> = { ı: "i", ł: "l", ø: "o", đ: "d", ð: "d", þ: "th", æ: "ae", œ: "oe", ß: "ss" };

/** A word as it is compared: one normal form, no accents, no case — "José", "JOSE" and "jose" are one word. */
function fold(word: string): string {
  return word
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[ıłøđðþæœß]/g, (c) => UNMARKED[c] ?? c);
}

/** Written all in lower case (a script without case never is). */
const lowerCase = (word: string) => word === word.toLowerCase() && word !== word.toUpperCase();

/** Shared mailboxes and the like: the name part of "team@…" is nobody's name. */
const MAILBOXES = new Set(
  "info team hello hi hey admin sales support help contact office mail email accounts account billing finance marketing enquiries inquiries service services orders bookings reception press media jobs careers legal privacy security noreply reply webmaster postmaster studio shop store owner founder general main work test demo user uk us eu co me it hr pr my ltd inc llc the and dev ops web biz org com net".split(
    " ",
  ),
);

/**
 * Names that are also everyday words. In lower case one of these is read as the word ("we will
 * lead with the price"), so a person called Will Price keeps their sentences; written as a name
 * ("Will", "PRICE") it goes like any other. Only words that turn up in lower case in ordinary
 * writing belong here: a name that is rarely a word (smith, martin, finch) is safer taken out
 * however it is written.
 */
const EVERYDAY = new Set(
  (
    "will may mark bill rose grace hope joy faith charity summer autumn winter spring dawn art frank rich guy pat sue rob ray max don drew " +
    "chase cash miles chance king prince page price young long short small little best good love white brown green black gray grey blue gold silver " +
    "stone wood woods hill hills field fields lake rivers brook brooks bush forest park parks lane street way bridge bridges ford church mill mills " +
    "bell banks bank case cross read wise snow frost rain storm weeks week day days major marks power powers law laws rush moon star west north south east " +
    "baker cook carpenter farmer gardener singer driver rider hunt fox wolf hawk crow swan bird bull lamb fish salmon rice berry cherry olive ginger pepper " +
    "sage basil rosemary daisy lily ivy holly iris violet jasmine pearl ruby amber crystal diamond penny sterling savage sharp strong swift wild noble " +
    "hardy moody jolly merry bright sweet poor low high bond booth burns chambers close cotton court dear down early flowers foot forward fry gates glass " +
    "grant guest hall hand head home hook house judge keen lord march mayor nail peel plant pool pound prior quick ring salt sellers sides speed staff " +
    "steel stock temple tree wall ward waters wells worth yard bay bee buck bud burn chip cliff clay dash harmony jewel melody misty norm pierce rod rusty " +
    "sandy skip sky stormy sunny angel christian sergeant justice destiny patience honor honour mercy"
  ).split(" "),
);

export interface IdentityScrubber {
  /** The string with the person taken out. `hidden` collects the words that went as their name. */
  (value: string, hidden?: Set<string>): string;
  /** Whether the string holds what can only be them: an email address, or two parts of their name together. */
  names(value: string): boolean;
}

/**
 * Takes the person out of a string:
 *
 *  - anything shaped like an email address → `[email]`;
 *  - the product's own ids for them and for what they have, where one is quoted → `[id]` (an id
 *    short enough to be an ordinary number or word is left: it names nobody);
 *  - each part of their name, and of the name part of their address → `[name]`. A part of four
 *    letters or more goes however it is written (accents and case aside), and from five letters
 *    inside a longer word too ("okaforplumbing"). A part of two or three letters, or one that is
 *    also an everyday word, goes when it is written as a name is ("Li", "Jo", "Will") or sits
 *    beside another part ("li wu"), so a person called An or Will doesn't cost every sentence
 *    its "an" and "will". In a script written without spaces the name goes wherever it appears.
 *
 * A surname in a brand's name goes too: better a gap than a name. It is a net, not a proof —
 * a nickname the product never sent, or a handle unlike their name, can't be known to be them.
 */
export function identityScrubber(person: {
  name?: string | null;
  email?: string | null;
  /** The product's own id for them. */
  userId?: string | null;
  /** The product's ids for what they have (brands, workspaces…). */
  otherIds?: ReadonlyArray<string | null | undefined>;
}): IdentityScrubber {
  const wordsOf = (text: string) => (text.normalize("NFC").match(WORD) ?? []).filter((w) => /\p{L}/u.test(w));
  const nameParts = wordsOf(person.name ?? "");
  const local = (person.email ?? "").split("@")[0] ?? "";
  const localParts = wordsOf(local).filter((w) => !MAILBOXES.has(fold(w)));

  // `plain`: taken out however it is written. `written`: only as a name is written, or beside another part.
  const plain = new Set<string>();
  const written = new Set<string>();
  for (const f of [...nameParts, ...localParts].map(fold)) {
    if (f.length >= 4 && !EVERYDAY.has(f)) plain.add(f);
    else if (f.length >= 2) written.add(f);
  }
  // The name run together, and the address's name part ("jokafor"): each a word of its own.
  const whole = [nameParts.join(""), [...nameParts].reverse().join(""), local.replace(/[^\p{L}\p{N}]/gu, "")].map(fold);
  const together = new Set(whole.slice(0, 2).filter((f) => nameParts.length > 1 && f.length >= 4));
  for (const f of whole) if (f.length >= 5 && !MAILBOXES.has(f) && !EVERYDAY.has(f)) plain.add(f);
  const inside = [...plain].filter((f) => f.length >= 5);
  const unspaced = nameParts.filter((w) => UNSPACED.test(w));
  const fullUnspaced = unspaced.length > 1 ? [unspaced.join(""), [...unspaced].reverse().join("")] : [];
  const anywhere = [...new Set([...fullUnspaced, ...unspaced])].filter((w) => [...w].length >= 2).sort((a, b) => b.length - a.length);

  const quoted = (id: string) => new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(id)}(?![\\p{L}\\p{N}_])`, "giu");
  const digits = (id: string) => /^\d+$/.test(id);
  const theirs = person.userId && (digits(person.userId) ? person.userId.length >= 6 : person.userId.length >= 4) ? [person.userId] : [];
  const others = (person.otherIds ?? []).filter((id): id is string => !!id && (digits(id) ? id.length >= 6 : /\d/.test(id) ? id.length >= 4 : id.length >= 12));
  // Longest first, so an id that holds another goes whole.
  const ids = [...new Set([...theirs, ...others])].sort((a, b) => b.length - a.length).map(quoted);

  /** The words of a string, with which of them are a part of the name and what lies between neighbours. */
  const read = (text: string) => {
    const tokens = [...text.matchAll(WORD)].map((m) => ({ at: m.index, word: m[0], f: fold(m[0]) }));
    const part = tokens.map((t) => plain.has(t.f) || written.has(t.f));
    const beside = (i: number, j: number) => {
      if (j < 0 || j >= tokens.length || !part[j]) return false;
      const [a, b] = i < j ? [tokens[i]!, tokens[j]!] : [tokens[j]!, tokens[i]!];
      return BETWEEN.test(text.slice(a.at + a.word.length, b.at));
    };
    return { tokens, part, beside };
  };

  const withoutName = (value: string, hidden?: Set<string>): string => {
    let text = value;
    for (const name of anywhere) {
      if (!text.includes(name)) continue;
      hidden?.add(name);
      text = text.split(name).join("[name]");
    }
    const { tokens, part, beside } = read(text);
    let out = "";
    let from = 0;
    tokens.forEach((t, i) => {
      const sure = plain.has(t.f) || (written.has(t.f) && !lowerCase(t.word)) || inside.some((n) => t.f.length > n.length && t.f.includes(n));
      if (!sure && !(part[i] && (beside(i, i - 1) || beside(i, i + 1)))) return;
      hidden?.add(t.word);
      out += `${text.slice(from, t.at)}[name]`;
      from = t.at + t.word.length;
    });
    return out + text.slice(from);
  };

  const scrub = (value: string, hidden?: Set<string>): string => {
    const noAddress = value.normalize("NFC").replace(EMAIL_LIKE, "[email]");
    return withoutName(
      ids.reduce((out, re) => out.replace(re, "[id]"), noAddress),
      hidden,
    );
  };
  const names = (value: string): boolean => {
    const text = value.normalize("NFC");
    if (text.search(EMAIL_LIKE) !== -1 || fullUnspaced.some((name) => text.includes(name))) return true;
    const { tokens, part, beside } = read(text);
    return tokens.some((t, i) => together.has(t.f) || (part[i] && beside(i, i + 1)));
  };
  return Object.assign(scrub, { names });
}

/** The scrubber for a stored product user: what a plan goes through on its way to a prompt. */
export function personScrubber(user: Pick<ProductUser, "firstName" | "lastName" | "email" | "externalUserId" | "entities">): IdentityScrubber {
  return identityScrubber({
    name: [user.firstName, user.lastName].filter(Boolean).join(" "),
    email: user.email,
    userId: user.externalUserId,
    otherIds: Object.keys(user.entities ?? {}),
  });
}

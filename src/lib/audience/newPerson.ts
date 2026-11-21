import { z } from "zod";
import { CONSENT_NOTE_MAX } from "@/lib/ontology/consent";

/**
 * New person (AUDIENCE_ADD_PERSON_ENABLED): what the form sends, how it is checked, the ways
 * someone can agree to marketing email, and every message the form shows. Pure (zod only), so
 * the form, the routes and the help page share it.
 */

/** How someone agreed to marketing email, as the form offers it (owner, 20 Nov). "Other" needs a note. */
export const CONSENT_WAYS = [
  { how: "in_person", label: "Told me in person" },
  { how: "signed_form", label: "Signed a form" },
  { how: "email_reply", label: "Replied by email" },
  { how: "other", label: "Other" },
] as const;
export type ConsentWay = (typeof CONSENT_WAYS)[number]["how"];
const CONSENT_WAY_IDS = CONSENT_WAYS.map((w) => w.how) as [ConsentWay, ...ConsentWay[]];

/** A way's words, for the person's page and the export. */
export function consentWayLabel(how: string): string {
  return CONSENT_WAYS.find((w) => w.how === how)?.label ?? "Another way";
}

/** Where the form was opened: the People list or ⌘K. Vizzy's draft (group 11) adds its own. */
export const NEW_PERSON_VIA = ["form", "palette"] as const;
export type NewPersonVia = (typeof NEW_PERSON_VIA)[number];

/** An address as the sign-up form checks one. */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Digits with the usual marks; trimmed only, exactly as a sign-up's phone is, so the two match. */
const PHONE_RE = /^\+?[0-9][0-9 ().-]{1,38}$/;
export const NAME_MAX = 100;

const AgreedSchema = z
  .object({
    how: z.enum(CONSENT_WAY_IDS),
    note: z.string().trim().max(CONSENT_NOTE_MAX).optional(),
  })
  .strict();

const Body = z
  .object({
    email: z.string().trim().max(320).optional(),
    phone: z.string().trim().max(40).optional(),
    firstName: z.string().trim().max(NAME_MAX).optional(),
    lastName: z.string().trim().max(NAME_MAX).optional(),
    /** How they agreed to marketing email; absent or null: not yet. */
    agreed: AgreedSchema.nullable().optional(),
    /** Field values (AUDIENCE_FIELDS_ENABLED), set through the one writer once they are added. */
    fields: z.record(z.string().max(64), z.unknown()).optional(),
    via: z.enum(NEW_PERSON_VIA).optional(),
  })
  .strict();

/** A New person, checked: an email or a phone, names or null, and how they agreed or null. */
export interface NewPerson {
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  agreed: { how: ConsentWay; note: string | null } | null;
  fields: Record<string, unknown>;
  via: NewPersonVia;
}

export type NewPersonError = "email_or_phone" | "invalid_email" | "invalid_phone" | "note_needed" | "invalid_input";

/** Agreement as recorded later, from a person's page: a way, and a note that "Other" needs. */
export function parseAgreed(raw: unknown): { ok: true; value: { how: ConsentWay; note: string | null } } | { ok: false; error: "note_needed" | "invalid_input" } {
  const parsed = AgreedSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "invalid_input" };
  const note = parsed.data.note || null;
  if (parsed.data.how === "other" && !note) return { ok: false, error: "note_needed" };
  return { ok: true, value: { how: parsed.data.how, note } };
}

/** The form's body, checked, with a plain code for what is wrong. */
export function parseNewPerson(raw: unknown): { ok: true; value: NewPerson } | { ok: false; error: NewPersonError } {
  const parsed = Body.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "invalid_input" };
  const b = parsed.data;
  const email = b.email || null;
  const phone = b.phone || null;
  if (!email && !phone) return { ok: false, error: "email_or_phone" };
  if (email && !EMAIL_RE.test(email)) return { ok: false, error: "invalid_email" };
  if (phone && !PHONE_RE.test(phone)) return { ok: false, error: "invalid_phone" };
  let agreed: NewPerson["agreed"] = null;
  if (b.agreed) {
    const a = parseAgreed(b.agreed);
    if (!a.ok) return { ok: false, error: a.error };
    agreed = a.value;
  }
  return {
    ok: true,
    value: {
      email,
      phone,
      firstName: b.firstName || null,
      lastName: b.lastName || null,
      agreed,
      fields: b.fields ?? {},
      via: b.via ?? "form",
    },
  };
}

/** What the form and the person's page say. The help page (your-audience, #add) quotes them. */
export const NEW_PERSON_MESSAGES = {
  email_or_phone: "Add an email address or a phone number.",
  invalid_email: "That email address doesn't look right. Check it and try again.",
  invalid_phone: "That phone number doesn't look right. Use digits, with + and spaces if you like.",
  note_needed: "Add a short note to say how they agreed.",
  invalid_input: "Check the form and try again.",
  consent_elsewhere: "Only people added by hand have their agreement recorded here. Consent for anyone else comes from their launch or your product.",
  forbidden: "Only admins can add people.",
  rate_limited: "That's a lot of people at once. Wait a minute, then try again.",
  unknown_field: "One of the fields is no longer there. Reload the page and try again.",
  archived_field: "One of the fields was archived. Reload the page and try again.",
  invalid_value: "One of the field values doesn't fit its field. Check it and try again.",
  failed: "That didn't save. Try again.",
  fields_not_saved: "They were added, but their field values didn't save. Set them on their page.",
} as const;
export type NewPersonMessage = keyof typeof NEW_PERSON_MESSAGES;

/** The plain words for an error a New person or consent route answered. */
export function newPersonErrorText(data: unknown): string {
  const d = (data ?? {}) as { error?: string };
  return (d.error && (NEW_PERSON_MESSAGES as Record<string, string>)[d.error]) || NEW_PERSON_MESSAGES.failed;
}

/** The form's notes, word for word. */
export const NEW_PERSON_NOTES = {
  emailHint: "Or leave it empty and add a phone number.",
  phoneOnly: "Added with a phone only? If they later sign up with an email, that sign-up becomes a separate person.",
  agreeHint: 'Saved with your name and the time. "Other" needs a short note. Joining a list never counts as agreeing.',
  nothingSent: "Nothing is sent to people added by hand yet. Recording that they agreed means they can be emailed once lists reach them.",
  existing: "If this email is already in People, you'll go to that person instead of adding a second one.",
} as const;

/**
 * The people warning: shown when the plan's people limit is reached or under 1% of it is left. It
 * guides and never blocks (gates guide, never lock). Null: nothing to say.
 */
export function peopleWarning(allowance: { used: number; limit: number } | null): string | null {
  if (!allowance || !Number.isFinite(allowance.limit) || allowance.limit <= 0) return null;
  const room = allowance.limit - allowance.used;
  if (room >= Math.max(1, Math.ceil(allowance.limit * 0.01))) return null;
  const n = (v: number) => v.toLocaleString("en-GB");
  return `Your plan includes ${n(allowance.limit)} people and you have ${n(allowance.used)}. You can still add people.`;
}

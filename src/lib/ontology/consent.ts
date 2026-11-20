import { z } from "zod";

/**
 * Consent, as the event history records it (consent.recorded in ontology_events). The current
 * state stays on the person record; each event is the proof of one change. Piece F adds
 * withdrawal and the settings; B4 records consent given when someone is added by hand.
 *
 * Pure: zod only, so client components can import it.
 */

/** What a person can agree to. Support replies count as transactional. */
export const CONSENT_PURPOSES = ["marketing_email", "product_email", "transactional"] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

/** B4 records granted only; F decides how a withdrawal is recorded. */
export const CONSENT_STATES = ["granted", "withdrawn"] as const;
export type ConsentState = (typeof CONSENT_STATES)[number];

/** How it was given, in a short code (B4 owns the list), e.g. "verbal" or "signed_form". */
export const CONSENT_HOW = /^[a-z_]{1,40}$/;
export const CONSENT_NOTE_MAX = 500;

export interface ConsentRecordedProperties {
  purpose: ConsentPurpose;
  state: ConsentState;
  how: string;
  /** The team's note, up to 500 characters. */
  note: string | null;
  /** The team member who recorded it, by user id: never an address. */
  recordedBy: string;
  /** When the person agreed, when that is known and differs from when it was recorded. */
  agreedAt: string | null;
}

export const ConsentRecordedPropertiesSchema = z.object({
  purpose: z.enum(CONSENT_PURPOSES),
  state: z.enum(CONSENT_STATES),
  how: z.string().regex(CONSENT_HOW),
  note: z.string().max(CONSENT_NOTE_MAX).nullable(),
  recordedBy: z
    .string()
    .min(1)
    .max(128)
    .refine((v) => !v.includes("@") && !/\s/.test(v), { message: "an id, never an address" }),
  agreedAt: z
    .string()
    .max(40)
    .refine((v) => Number.isFinite(Date.parse(v)), { message: "not a time" })
    .nullable(),
});

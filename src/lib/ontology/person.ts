import { z } from "zod";

/**
 * The person id the ontology means on every row: the `ct_` id of a person record in `contacts`,
 * the shape deterministicContactId gives (src/lib/crm/identifiers.ts, through personIdOf in
 * src/lib/audience/personSync.ts). One person, once per brand.
 *
 * Not the same as isPersonId in src/lib/audience/paths.ts, a loose id check the person view uses
 * for product user ids (`pu_`). Older code also calls a product user id `personId`; piece B
 * renames those, and from piece 0 on a row's `personId` always means this id.
 *
 * Pure: no imports from the app, so any layer can use it.
 */
export type ContactPersonId = `ct_${string}`;

/** `ct_` and 40 lower case hex characters: a sha256 of the brand and the person's key, cut to 40. */
export const CONTACT_PERSON_ID = /^ct_[0-9a-f]{40}$/;

export function isContactPersonId(value: unknown): value is ContactPersonId {
  return typeof value === "string" && CONTACT_PERSON_ID.test(value);
}

/** The value as a ContactPersonId, or an error: for ids that must already be right. */
export function asContactPersonId(value: unknown): ContactPersonId {
  if (!isContactPersonId(value)) throw new Error("not_a_contact_person_id");
  return value;
}

export const ContactPersonIdSchema = z.string().regex(CONTACT_PERSON_ID);

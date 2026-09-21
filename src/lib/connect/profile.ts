import { createHash } from "node:crypto";
import { z } from "zod";
import { normalizeEmail } from "@/lib/waitlist/identifiers";
import { isPublicEmailProvider } from "@/lib/domains/registrableDomain";
import type { ConsentBasis, ProductConnection } from "@/lib/types/productConnection";
import type { ProductUser, TraitValue } from "@/lib/types/productUser";
import {
  LIMITS,
  PreferencesUpdatedPropsSchema,
  RESERVED_EVENTS,
  StepCompletedPropsSchema,
  type IngestMessage,
} from "./protocol";

/**
 * How one ingested message changes a product user — PURE (no I/O), so every rule
 * is unit-tested and the ingest transaction just applies the result.
 *
 * - Traits are last-write-wins by EVENT time: an identify older than the newest
 *   one applied is recorded but changes nothing (out-of-order delivery is safe).
 * - Onboarding steps keep their EARLIEST completion time; milestones keep
 *   first/last/count.
 * - Consent is what the product asserts, except `corporate_subscriber` on a
 *   public email domain (gmail…) is treated as `none` when the connection's
 *   policy says so. The asserted basis is kept, so it re-evaluates if the email
 *   changes.
 * - `user.deleted` clears all PII and leaves a tombstone for ~30 days; any other
 *   message for a tombstoned user is rejected.
 */

type Doc = Omit<ProductUser, "id" | "tenantId">;

export type ApplyResult = { next: Doc | null; applied: boolean } | { reject: string };

/** Tombstones of deleted users are kept this long (blocks stale re-creation). */
export const TOMBSTONE_TTL_MS = 30 * 24 * 3600_000;

function sha(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 32);
}

/** Deterministic product-user id: stable per connection, unique across tenants. */
export function productUserDocId(connectionId: string, externalUserId: string): string {
  return `pu_${sha(`${connectionId}:${externalUserId}`)}`;
}

/** Deterministic event id: the idempotency gate for a messageId. */
export function productEventDocId(connectionId: string, messageId: string): string {
  return `pe_${sha(`${connectionId}:${messageId}`)}`;
}

/** An ISO timestamp normalised to UTC, so string comparison is time order. */
export function toUtcIso(ts: string): string {
  return new Date(ts).toISOString();
}

const min = (a: string | undefined, b: string) => (a && a < b ? a : b);
const max = (a: string | undefined, b: string) => (a && a > b ? a : b);

const EmailSchema = z.string().email().max(254);
const LOCALE_RE = /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/;

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function domainOf(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  return at > 0 ? email.slice(at + 1) : null;
}

/** The basis actually used for sending (see the header comment). */
export function effectiveBasis(
  asserted: ConsentBasis,
  email: string | null | undefined,
  connection: Pick<ProductConnection, "consentPolicy">,
): ConsentBasis {
  if (asserted !== "corporate_subscriber" || !connection.consentPolicy.verifyCorporateDomain) {
    return asserted;
  }
  const domain = domainOf(email);
  return !domain || isPublicEmailProvider(domain) ? "none" : asserted;
}

/** Reserved identity traits → profile fields (camelCase or snake_case accepted). */
const RESERVED: Record<string, "email" | "firstName" | "lastName" | "timezone" | "locale"> = {
  email: "email",
  firstName: "firstName",
  first_name: "firstName",
  lastName: "lastName",
  last_name: "lastName",
  timezone: "timezone",
  locale: "locale",
};

/** Apply identify-style traits to `doc` in place. Returns a rejection or null. */
function applyTraits(doc: Doc, traits: Record<string, TraitValue>): string | null {
  const custom = { ...doc.traits };
  for (const [key, value] of Object.entries(traits)) {
    const field = RESERVED[key];
    if (!field) {
      if (value === null) delete custom[key];
      else custom[key] = value;
      continue;
    }
    if (value !== null && typeof value !== "string") return `invalid_${field}`;
    switch (field) {
      case "email": {
        if (value === null) {
          doc.email = null;
          doc.emailNormalized = null;
        } else {
          if (!EmailSchema.safeParse(value.trim()).success) return "invalid_email";
          doc.email = value.trim();
          doc.emailNormalized = normalizeEmail(value);
        }
        break;
      }
      case "timezone":
        if (value !== null && !isValidTimezone(value)) return "invalid_timezone";
        doc.timezone = value;
        break;
      case "locale":
        if (value !== null && !LOCALE_RE.test(value)) return "invalid_locale";
        doc.locale = value;
        break;
      default:
        doc[field] = value === null ? null : value.slice(0, 100);
    }
  }
  if (Object.keys(custom).length > LIMITS.maxTraits) return "too_many_traits";
  doc.traits = custom;
  return null;
}

function skeleton(
  connection: Pick<ProductConnection, "id">,
  externalUserId: string,
  eventTime: string,
  now: string,
): Doc {
  return {
    connectionId: connection.id,
    externalUserId,
    email: null,
    emailNormalized: null,
    firstName: null,
    lastName: null,
    timezone: null,
    locale: null,
    traits: {},
    traitsUpdatedAt: null,
    steps: {},
    milestones: {},
    consent: null,
    emailPreferences: {},
    status: "active",
    firstSeenAt: eventTime,
    lastSeenAt: eventTime,
    createdAt: now,
    updatedAt: now,
  };
}

function withoutIdentity(user: ProductUser): Doc {
  const { id: _id, tenantId: _tenantId, ...rest } = user;
  return rest;
}

/** The PII-free tombstone a deleted user becomes (kept ~30 days, then TTL'd). */
export function tombstoneOf(current: ProductUser, nowMs: number): Doc {
  const now = new Date(nowMs).toISOString();
  return {
    connectionId: current.connectionId,
    externalUserId: current.externalUserId,
    email: null,
    emailNormalized: null,
    firstName: null,
    lastName: null,
    timezone: null,
    locale: null,
    traits: {},
    traitsUpdatedAt: null,
    steps: {},
    milestones: {},
    consent: null,
    emailPreferences: {},
    status: "deleted",
    ttlAt: new Date(nowMs + TOMBSTONE_TTL_MS),
    firstSeenAt: current.firstSeenAt,
    lastSeenAt: current.lastSeenAt,
    createdAt: current.createdAt,
    updatedAt: now,
  };
}

/**
 * Compute the next profile for one message. `msg.timestamp` must already be
 * normalised to UTC (see toUtcIso).
 */
export function applyMessage(
  current: ProductUser | null,
  msg: IngestMessage,
  opts: { connection: Pick<ProductConnection, "id" | "consentPolicy">; nowMs: number },
): ApplyResult {
  const now = new Date(opts.nowMs).toISOString();
  const ts = msg.timestamp;
  const isDelete = msg.type === "track" && msg.event === RESERVED_EVENTS.userDeleted;

  if (current?.status === "deleted") {
    // Deleting twice is a no-op; anything else for a deleted user is refused.
    return isDelete ? { next: null, applied: false } : { reject: "user_deleted" };
  }
  if (isDelete) {
    return current ? { next: tombstoneOf(current, opts.nowMs), applied: true } : { next: null, applied: false };
  }

  const base: Doc = current ? withoutIdentity(current) : skeleton(opts.connection, msg.userId, ts, now);
  const doc: Doc = {
    ...base,
    traits: { ...base.traits },
    steps: { ...base.steps },
    milestones: { ...base.milestones },
    emailPreferences: { ...base.emailPreferences },
  };
  let applied = false;

  // Traits (identify, or traits riding on a track): last-write-wins by event time.
  const traits = msg.traits;
  const newestTraits = !doc.traitsUpdatedAt || ts >= doc.traitsUpdatedAt;
  if (traits && Object.keys(traits).length > 0 && newestTraits) {
    const bad = applyTraits(doc, traits);
    if (bad) return { reject: bad };
    doc.traitsUpdatedAt = ts;
    applied = true;
  }

  // Consent (identify only): last-write-wins by event time.
  if (msg.type === "identify" && msg.consent) {
    if (!doc.consent || ts >= doc.consent.at) {
      doc.consent = {
        basis: msg.consent.basis,
        assertedBasis: msg.consent.basis,
        source: msg.consent.source ?? null,
        at: ts,
      };
      applied = true;
    }
  }
  // Re-derive the effective basis from what the product asserted (the email may
  // have changed in this message).
  if (doc.consent) {
    const asserted = doc.consent.assertedBasis ?? doc.consent.basis;
    doc.consent = { ...doc.consent, assertedBasis: asserted, basis: effectiveBasis(asserted, doc.email, opts.connection) };
  }

  if (msg.type === "track") {
    const prev = doc.milestones[msg.event];
    doc.milestones[msg.event] = {
      firstAt: min(prev?.firstAt, ts),
      lastAt: max(prev?.lastAt, ts),
      count: (prev?.count ?? 0) + 1,
    };
    applied = true;

    if (msg.event === RESERVED_EVENTS.stepCompleted) {
      const p = StepCompletedPropsSchema.safeParse(msg.properties);
      if (!p.success) return { reject: "invalid_step" };
      doc.steps[p.data.step] = { doneAt: min(doc.steps[p.data.step]?.doneAt, ts) };
    } else if (msg.event === RESERVED_EVENTS.preferencesUpdated) {
      const p = PreferencesUpdatedPropsSchema.safeParse(msg.properties);
      if (!p.success) return { reject: "invalid_preferences" };
      const prevPref = doc.emailPreferences[p.data.category];
      if (!prevPref || ts >= prevPref.at) {
        doc.emailPreferences[p.data.category] = { subscribed: p.data.subscribed, at: ts };
      }
    }
  }

  if (!applied) return { next: null, applied: false };
  doc.firstSeenAt = min(doc.firstSeenAt, ts);
  doc.lastSeenAt = max(doc.lastSeenAt, ts);
  doc.updatedAt = now;
  return { next: doc, applied: true };
}

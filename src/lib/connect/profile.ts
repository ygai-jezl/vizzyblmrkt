import { createHash } from "node:crypto";
import { z } from "zod";
import { normalizeEmail } from "@/lib/waitlist/identifiers";
import { isPublicEmailProvider } from "@/lib/domains/registrableDomain";
import type { ConnectionCatalog, ConsentBasis, ProductConnection } from "@/lib/types/productConnection";
import type { ProductUser, TraitValue } from "@/lib/types/productUser";
import {
  LIMITS,
  PreferencesUpdatedPropsSchema,
  RESERVED_EVENTS,
  StepCompletedPropsSchema,
  type IngestMessage,
} from "./protocol";
import { V2_LIMITS, type SkipReason, type UserPatch, type UserState } from "./v2/contract";

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

/**
 * The PII-free tombstone a deleted user becomes (kept ~30 days, then TTL'd). It
 * keeps no user id: its doc id — a one-way hash of the connection and user ids —
 * is all that's needed to recognise a late write for the same person.
 */
export function tombstoneOf(current: Pick<ProductUser, "connectionId" | "firstSeenAt" | "lastSeenAt" | "createdAt">, nowMs: number): Doc {
  const now = new Date(nowMs).toISOString();
  return {
    connectionId: current.connectionId,
    externalUserId: "",
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
    signedUpAt: null,
    excluded: null,
    facts: {},
    stateUpdatedAt: null,
    deletedAt: now,
    activated: false,
    activatedAt: null,
    ttlAt: new Date(nowMs + TOMBSTONE_TTL_MS),
    firstSeenAt: current.firstSeenAt,
    lastSeenAt: current.lastSeenAt,
    createdAt: current.createdAt,
    updatedAt: now,
  };
}

/** A tombstone for a user we never saw (a DELETE first), so an older late write can't create them. */
export function newTombstone(connection: Pick<ProductConnection, "id">, nowMs: number): Doc {
  const now = new Date(nowMs).toISOString();
  return tombstoneOf({ connectionId: connection.id, firstSeenAt: now, lastSeenAt: now, createdAt: now }, nowMs);
}

// ---- API v2: state writes ------------------------------------------------------

export type PatchResult =
  | { next: Doc; applied: true }
  | { skipped: SkipReason; storedUpdatedAt: string | null }
  | { invalid: Array<{ path: string; message: string }> };

/**
 * API v2: apply one PATCH — a JSON Merge Patch (RFC 7396) of the user's state —
 * to their profile. PURE, like applyMessage.
 *
 * - Scalars: a value replaces ours, `null` clears. Maps (`steps`, `facts`,
 *   `traits`) merge key by key; a `null` value removes that key.
 * - `updatedAt` (optional) is when the product read this state: a write older
 *   than the newest one applied is ignored (`stale_write`). Writes without it
 *   always apply, and never move that bar — so two clocks can't fight.
 * - A deleted user (tombstone): a write older than the deletion is ignored
 *   (`deleted_later`); any other write starts a fresh person.
 */
export function applyUserPatch(
  current: ProductUser | null,
  userId: string,
  patch: UserPatch,
  opts: {
    connection: Pick<ProductConnection, "id" | "consentPolicy"> & { catalog?: Pick<ConnectionCatalog, "onboardingSteps"> };
    nowMs: number;
  },
): PatchResult {
  const now = new Date(opts.nowMs).toISOString();
  const writeAt = patch.updatedAt ? toUtcIso(patch.updatedAt) : null;
  let prev = current;
  if (prev?.status === "deleted") {
    const deletedAt = prev.deletedAt ?? prev.updatedAt;
    if (writeAt && writeAt < deletedAt) return { skipped: "deleted_later", storedUpdatedAt: null };
    prev = null; // a fresh person under the same id
  }
  if (prev && writeAt && prev.stateUpdatedAt && writeAt < prev.stateUpdatedAt) {
    return { skipped: "stale_write", storedUpdatedAt: prev.stateUpdatedAt };
  }

  const base: Doc = prev ? withoutIdentity(prev) : skeleton(opts.connection, userId, now, now);
  const doc: Doc = {
    ...base,
    traits: { ...base.traits },
    steps: { ...base.steps },
    facts: { ...(base.facts ?? {}) },
    milestones: { ...base.milestones },
    emailPreferences: { ...base.emailPreferences },
  };
  const at = writeAt ?? now;

  if (patch.email !== undefined) {
    doc.email = patch.email === null ? null : patch.email.trim();
    doc.emailNormalized = patch.email === null ? null : normalizeEmail(patch.email);
  }
  if (patch.firstName !== undefined) doc.firstName = patch.firstName;
  if (patch.lastName !== undefined) doc.lastName = patch.lastName;
  if (patch.timezone !== undefined) doc.timezone = patch.timezone;
  if (patch.locale !== undefined) doc.locale = patch.locale;
  if (patch.signedUpAt !== undefined) doc.signedUpAt = toUtcIso(patch.signedUpAt);
  if (patch.consent !== undefined) {
    doc.consent = patch.consent === null ? null : { basis: patch.consent, assertedBasis: patch.consent, source: "api", at };
  }
  // Re-derive the effective basis from what the product asserted (the email may have changed).
  if (doc.consent) {
    const asserted = doc.consent.assertedBasis ?? doc.consent.basis;
    doc.consent = { ...doc.consent, assertedBasis: asserted, basis: effectiveBasis(asserted, doc.email, opts.connection) };
  }
  if (patch.subscribed !== undefined) doc.subscribed = patch.subscribed;
  if (patch.excluded !== undefined) doc.excluded = patch.excluded === null ? null : { reason: patch.excluded.reason, at };

  for (const [id, doneAt] of Object.entries(patch.steps ?? {})) {
    if (doneAt === null) delete doc.steps[id];
    else doc.steps[id] = { doneAt: toUtcIso(doneAt) };
  }
  for (const [id, value] of Object.entries(patch.facts ?? {})) {
    if (value === null) delete doc.facts![id];
    else doc.facts![id] = { value, at };
  }
  for (const [key, value] of Object.entries(patch.traits ?? {})) {
    if (value === null) delete doc.traits[key];
    else doc.traits[key] = value;
  }
  const invalid: Array<{ path: string; message: string }> = [];
  if (Object.keys(doc.traits).length > V2_LIMITS.maxTraits) invalid.push({ path: "traits", message: `more than ${V2_LIMITS.maxTraits} traits after this write` });
  if (Object.keys(doc.facts ?? {}).length > V2_LIMITS.maxFacts) invalid.push({ path: "facts", message: `more than ${V2_LIMITS.maxFacts} facts after this write` });
  if (Object.keys(doc.steps).length > V2_LIMITS.maxSteps) invalid.push({ path: "steps", message: `more than ${V2_LIMITS.maxSteps} steps after this write` });
  if (invalid.length) return { invalid };

  if (writeAt) doc.stateUpdatedAt = max(doc.stateUpdatedAt ?? undefined, writeAt);
  if (!doc.activated) {
    const activated = activationAt(doc, opts.connection.catalog?.onboardingSteps ?? []);
    if (activated) {
      doc.activated = true;
      doc.activatedAt = activated;
    }
  }
  doc.lastSeenAt = max(doc.lastSeenAt, now);
  doc.updatedAt = now;
  return { next: doc, applied: true };
}

/** The user's state as API v2 returns it. */
export function userStateOf(user: ProductUser): UserState {
  return {
    userId: user.externalUserId,
    email: user.email ?? null,
    firstName: user.firstName ?? null,
    lastName: user.lastName ?? null,
    timezone: user.timezone ?? null,
    locale: user.locale ?? null,
    signedUpAt: user.signedUpAt ?? null,
    consent: user.consent?.assertedBasis ?? user.consent?.basis ?? null,
    subscribed: user.subscribed !== false,
    excluded: user.excluded ? { reason: user.excluded.reason } : null,
    steps: Object.fromEntries(Object.entries(user.steps).map(([id, s]) => [id, s.doneAt])),
    facts: Object.fromEntries(Object.entries(user.facts ?? {}).map(([id, f]) => [id, f.value])),
    traits: Object.fromEntries(Object.entries(user.traits).filter((e): e is [string, string | number | boolean] => e[1] !== null)),
    updatedAt: user.stateUpdatedAt ?? null,
  };
}

/**
 * When a user counts as activated: their first `onboarding.completed`, or the
 * moment every catalog onboarding step was done (the same rule as the lifecycle
 * field `onboarding.complete`), whichever came first. Null while neither holds.
 */
export function activationAt(
  doc: Pick<Doc, "milestones" | "steps">,
  steps: ReadonlyArray<{ id: string }>,
): string | null {
  const completed = doc.milestones[RESERVED_EVENTS.onboardingCompleted]?.firstAt ?? null;
  let allDone: string | null = null;
  if (steps.length > 0 && steps.every((s) => doc.steps[s.id])) {
    allDone = steps.reduce((latest, s) => max(latest, doc.steps[s.id]!.doneAt), "");
  }
  if (completed && allDone) return completed < allDone ? completed : allDone;
  return completed ?? allDone;
}

/**
 * Compute the next profile for one message. `msg.timestamp` must already be
 * normalised to UTC (see toUtcIso).
 */
export function applyMessage(
  current: ProductUser | null,
  msg: IngestMessage,
  opts: {
    connection: Pick<ProductConnection, "id" | "consentPolicy"> & {
      catalog?: Pick<ConnectionCatalog, "onboardingSteps">;
    };
    nowMs: number;
  },
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
  // Activation is recorded once and never undone (a later catalog change can't un-activate).
  if (!doc.activated) {
    const at = activationAt(doc, opts.connection.catalog?.onboardingSteps ?? []);
    if (at) {
      doc.activated = true;
      doc.activatedAt = at;
    }
  }
  doc.firstSeenAt = min(doc.firstSeenAt, ts);
  doc.lastSeenAt = max(doc.lastSeenAt, ts);
  doc.updatedAt = now;
  return { next: doc, applied: true };
}

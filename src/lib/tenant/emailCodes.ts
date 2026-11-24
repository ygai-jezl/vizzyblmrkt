import { timingSafeEqual } from "node:crypto";
import { getDb } from "./firestore";
import { TenantValidationError } from "./errors";
import type { FirestoreLike } from "./types";

/**
 * The emailed codes that confirm a password account's address (PASSWORD_SIGNIN_ENABLED, see
 * src/lib/auth/emailCode.ts). Control plane collection `email_codes`, one document per account,
 * its id the Firebase user id:
 *
 * - Only the code's SHA-256 is stored (src/lib/auth/emailCode.ts hashes `uid:email:code`), never
 *   the code or the address.
 * - One live code per account: a new send replaces the old one and its count of tries.
 * - Valid for 10 minutes and 5 tries. The fifth wrong try deletes it, and so does a check that
 *   finds it expired.
 * - Checked in a transaction, so tries racing each other are each counted, and compared in
 *   constant time.
 * - `ttl` is a Date at the expiry for the TTL policy infra/lifecycle/setup.sh ttl turns on, so a
 *   code nobody typed leaves nothing for long.
 *
 * Read by id only, so no index is needed. Nothing else reads or writes the collection.
 *
 * Control plane collection `email_code_guards`, one document per address, its id the SHA-256 of
 * the address in lower case (src/lib/auth/emailCode.ts), never the address. It holds the times of
 * the address's recent sends and wrong tries, across codes and across accounts made again for the
 * same address, so neither a new code nor a new account resets them:
 *
 * - At most 6 sends an hour (claimEmailCodeSend). Counted in a transaction here, so unlike the
 *   shared rate limiter it never fails open: a database error refuses the send.
 * - At most 15 wrong tries a day. Past that, the address gets no new code and no check until the
 *   day has passed.
 * - `ttl` is a Date a day after its last entry, for the TTL policy infra/lifecycle/setup.sh ttl
 *   turns on.
 */

export const EMAIL_CODES = "email_codes";
/** How long a code works after it is sent. */
export const EMAIL_CODE_VALID_MS = 10 * 60_000;
/** Wrong tries a code allows; the last one deletes it. */
export const EMAIL_CODE_MAX_TRIES = 5;

export const EMAIL_CODE_GUARDS = "email_code_guards";
/** Codes one address can be sent in an hour, whichever account asks. */
export const EMAIL_CODE_SENDS_PER_HOUR = 6;
/** Wrong tries one address can make in a day, across codes and accounts, before it is shut out. */
export const EMAIL_CODE_WRONG_PER_DAY = 15;

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const HASH_RE = /^[0-9a-f]{64}$/;

export type EmailCodeCheck =
  | { ok: true }
  | { ok: false; why: "wrong"; attemptsLeft: number }
  | { ok: false; why: "missing" | "expired" | "too_many" };

interface Opts {
  now?: Date;
  db?: FirestoreLike;
}

/** What claimEmailCodeSend answers: a send may go ahead, or why not. */
export type EmailCodeSendClaim = "ok" | "too_many_sends" | "shut_out";

function defaultDb(): FirestoreLike {
  return getDb() as unknown as FirestoreLike;
}

/** A Firebase user id usable as a document id (no path separator, no reserved name). */
function checkUid(uid: string): void {
  if (typeof uid !== "string" || uid.length < 1 || uid.length > 128 || uid.includes("/") || uid === "." || uid === ".." || /^__.*__$/.test(uid)) {
    throw new TenantValidationError("bad_email_code:uid");
  }
}

function checkHash(hash: string): void {
  if (typeof hash !== "string" || !HASH_RE.test(hash)) throw new TenantValidationError("bad_email_code:hash");
}

/**
 * The times in a guard's list (milliseconds) that are still inside the window. A time later than
 * `now` is kept and counted: requests take `now` when they start, so another request that started
 * later can commit first, and dropping its entry here would erase it from the guard.
 */
function recent(v: unknown, now: number, windowMs: number): number[] {
  if (!Array.isArray(v)) return [];
  return v.filter((t): t is number => typeof t === "number" && Number.isFinite(t) && t > now - windowMs);
}

/** The guard document for an address, its fields read and trimmed to their windows. */
function guardFields(data: Record<string, unknown> | null, now: number): { sends: number[]; wrong: number[] } {
  return { sends: recent(data?.sends, now, HOUR_MS), wrong: recent(data?.wrong, now, DAY_MS) };
}

function guardDoc(sends: number[], wrong: number[], now: number): Record<string, unknown> {
  const last = Math.max(now, ...sends, ...wrong);
  return { sends, wrong, ttl: new Date(last + DAY_MS) };
}

/**
 * Count a send for an address (its SHA-256), in one transaction: refused once it has had
 * EMAIL_CODE_SENDS_PER_HOUR in the last hour, or EMAIL_CODE_WRONG_PER_DAY wrong tries in the last
 * day. Throws when the database does; the caller refuses the send then.
 */
export async function claimEmailCodeSend(addressKey: string, opts: Opts = {}): Promise<EmailCodeSendClaim> {
  checkHash(addressKey);
  const now = (opts.now ?? new Date()).getTime();
  const db = opts.db ?? defaultDb();
  const ref = db.collection(EMAIL_CODE_GUARDS).doc(addressKey);
  return db.runTransaction(async (txn): Promise<EmailCodeSendClaim> => {
    const snap = await txn.get(ref);
    const { sends, wrong } = guardFields(snap.exists ? (snap.data() ?? null) : null, now);
    if (wrong.length >= EMAIL_CODE_WRONG_PER_DAY) return "shut_out";
    if (sends.length >= EMAIL_CODE_SENDS_PER_HOUR) return "too_many_sends";
    txn.set(ref, guardDoc([...sends, now], wrong, now));
    return "ok";
  });
}

/** Store a fresh code's hash for an account, replacing any code it had. */
export async function putEmailCode(uid: string, hash: string, opts: Opts = {}): Promise<void> {
  checkUid(uid);
  checkHash(hash);
  const now = opts.now ?? new Date();
  const expiresAt = new Date(now.getTime() + EMAIL_CODE_VALID_MS);
  const db = opts.db ?? defaultDb();
  await db.collection(EMAIL_CODES).doc(uid).set({
    hash,
    attempts: 0,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    ttl: expiresAt,
  });
}

/** Constant-time comparison of two hex SHA-256 hashes (both already checked to be 64 hex characters). */
function sameHash(stored: string, candidate: string): boolean {
  return timingSafeEqual(Buffer.from(stored, "hex"), Buffer.from(candidate, "hex"));
}

/**
 * Check a typed code's hash against the account's live code, in one transaction:
 *  - missing   no code (never sent, already used or deleted)
 *  - expired   past its 10 minutes; deleted
 *  - wrong     counted, with the tries left
 *  - too_many  this was the last wrong try, or the address (addressKey, its SHA-256) has had
 *              EMAIL_CODE_WRONG_PER_DAY wrong tries in the last day; deleted
 *  - ok        it matches. The code stays until the caller has confirmed the account and calls
 *              deleteEmailCode, so a failure in between can be retried with the same code.
 * Every wrong try is also counted against the address, whichever code or account it was for.
 */
export async function checkEmailCode(
  uid: string,
  candidateHash: string,
  opts: Opts & { addressKey: string },
): Promise<EmailCodeCheck> {
  checkUid(uid);
  checkHash(candidateHash);
  checkHash(opts.addressKey);
  const now = (opts.now ?? new Date()).getTime();
  const db = opts.db ?? defaultDb();
  const ref = db.collection(EMAIL_CODES).doc(uid);
  const guardRef = db.collection(EMAIL_CODE_GUARDS).doc(opts.addressKey);
  return db.runTransaction(async (txn): Promise<EmailCodeCheck> => {
    const snap = await txn.get(ref);
    const guardSnap = await txn.get(guardRef);
    const data = snap.exists ? (snap.data() ?? null) : null;
    if (!data || typeof data.hash !== "string" || !HASH_RE.test(data.hash)) return { ok: false, why: "missing" };
    const guard = guardFields(guardSnap.exists ? (guardSnap.data() ?? null) : null, now);
    if (guard.wrong.length >= EMAIL_CODE_WRONG_PER_DAY) {
      txn.delete(ref);
      return { ok: false, why: "too_many" };
    }
    const expiresAt = typeof data.expiresAt === "string" ? Date.parse(data.expiresAt) : Number.NaN;
    if (!(expiresAt > now)) {
      txn.delete(ref);
      return { ok: false, why: "expired" };
    }
    const attempts = typeof data.attempts === "number" && data.attempts >= 0 ? data.attempts : 0;
    if (attempts >= EMAIL_CODE_MAX_TRIES) {
      txn.delete(ref);
      return { ok: false, why: "too_many" };
    }
    if (sameHash(data.hash, candidateHash)) return { ok: true };
    txn.set(guardRef, guardDoc(guard.sends, [...guard.wrong, now], now));
    const tries = attempts + 1;
    if (tries >= EMAIL_CODE_MAX_TRIES || guard.wrong.length + 1 >= EMAIL_CODE_WRONG_PER_DAY) {
      txn.delete(ref);
      return { ok: false, why: "too_many" };
    }
    txn.update(ref, { attempts: tries });
    return { ok: false, why: "wrong", attemptsLeft: EMAIL_CODE_MAX_TRIES - tries };
  });
}

/** Remove an account's code (after it confirmed the account). Nothing there is fine. */
export async function deleteEmailCode(uid: string, opts: Pick<Opts, "db"> = {}): Promise<void> {
  checkUid(uid);
  const db = opts.db ?? defaultDb();
  await db.collection(EMAIL_CODES).doc(uid).delete();
}

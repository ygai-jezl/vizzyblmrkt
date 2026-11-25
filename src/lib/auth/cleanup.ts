import { isRateLimited, type RateLimitConfig } from "@/lib/tenant/rateLimit";
import { adminAuth } from "./adminAuth";
import { isPasswordCleanupDeleteEnabled, isPasswordSigninEnabled } from "./flags";

/**
 * The clean-up of unconfirmed password accounts. A password account that never typed its emailed
 * code can't get past the door (src/lib/auth/session.ts), so it holds nothing of ours. After 7 days
 * it is removed, which also stops any change of address a stranger may have started on it.
 *
 * An account is removed only when all of these hold: it has a password sign-in, its email is not
 * verified, it was created more than 7 days ago, and it has no tenant_id claim (the door never let
 * it in). With PASSWORD_CLEANUP_DELETE_ENABLED off it only logs what it would remove.
 *
 * It runs from the scheduled lifecycle tick while PASSWORD_SIGNIN_ENABLED is on, at most once an
 * hour across instances, within a small time budget. One run acts on at most 500 accounts; the next
 * hour carries on. Logs carry the account's uid and the domain of its address, never the address.
 */

export const CLEANUP = {
  /** An unconfirmed password account is removed once it is older than this. */
  MAX_AGE_MS: 7 * 24 * 60 * 60 * 1000,
  /** Accounts read per page of the account list (the most Firebase Auth returns). */
  PAGE_SIZE: 1000,
  /** Accounts removed, or with deletion off reported, in one run at most. */
  MAX_PER_RUN: 500,
  /** A run doesn't start, or use up its hour, with less time left than this. */
  MIN_RUN_MS: 2_000,
} as const;

/** The subject and limit of the once-an-hour gate, shared by every instance through Firestore. */
export const CLEANUP_RUN_SUBJECT = "auth-cleanup";
export const CLEANUP_RUN_LIMIT: RateLimitConfig = { prefix: "auth-cleanup-run", burstLimit: 1, hourlyLimit: 1 };

/** The event name on each account's log line, and on the run's summary line. */
export const SWEEP_EVENT = "auth_unconfirmed_sweep";
export const SWEEP_SUMMARY_EVENT = "auth_unconfirmed_sweep_summary";

/** The parts of a Firebase Auth user record the clean-up reads. */
export interface SweepUser {
  uid: string;
  email?: string;
  emailVerified: boolean;
  providerData: ReadonlyArray<{ providerId: string }>;
  metadata: { creationTime: string };
  customClaims?: Record<string, unknown>;
}

/** The parts of the firebase-admin Auth client the clean-up uses (tests pass a fake). */
export interface SweepAuth {
  listUsers(maxResults: number, pageToken?: string): Promise<{ users: SweepUser[]; pageToken?: string }>;
  deleteUser(uid: string): Promise<void>;
}

export type SweepOutcome = "deleted" | "would_delete" | "gone" | "failed";

export interface SweepResult {
  /** "delete" removes accounts; "log_only" (deletion switch off) only reports them. */
  mode: "delete" | "log_only";
  pages: number;
  /** Accounts looked at. */
  scanned: number;
  deleted: number;
  wouldDelete: number;
  /** Already removed by the time the clean-up got to them. */
  gone: number;
  failed: number;
  /** True when the time budget or the 500 limit stopped the run before the end of the list. */
  partial: boolean;
  /** Set when reading the account list failed (an error code, never an address). */
  error?: string;
}

export type SweepLogEntry = Record<string, unknown> & { severity: "INFO" | "WARNING"; message: string; event: string };

export interface SweepDeps {
  auth?: SweepAuth;
  clock?: () => number;
  /** Whether to delete; defaults to isPasswordCleanupDeleteEnabled(). */
  deleting?: boolean;
  log?: (entry: SweepLogEntry) => void;
}

export interface CleanupRunDeps extends SweepDeps {
  /** The once-an-hour gate across instances: true means another run had this hour (tests stub it). */
  limited?: () => Promise<boolean>;
}

/** Structured log line: Cloud Logging reads a JSON line as jsonPayload, with its severity. */
function writeLog(entry: SweepLogEntry): void {
  const line = JSON.stringify(entry);
  if (entry.severity === "WARNING") console.warn(line);
  else console.info(line);
}

/** The domain of an address, lower case, or "unknown". Never the part before the @. */
export function emailDomain(email: string | undefined): string {
  const at = email ? email.lastIndexOf("@") : -1;
  const domain = email && at >= 0 ? email.slice(at + 1).trim().toLowerCase() : "";
  return domain || "unknown";
}

/** Whether an account is an unconfirmed password account old enough to remove, at `nowMs`. */
export function isUnconfirmedPasswordAccount(user: SweepUser, nowMs: number): boolean {
  if (user.emailVerified) return false;
  if (!user.providerData?.some((p) => p.providerId === "password")) return false;
  // Any tenant_id claim, whatever its value, means the door let this account in once: keep it.
  if (user.customClaims && Object.prototype.hasOwnProperty.call(user.customClaims, "tenant_id")) return false;
  const created = Date.parse(user.metadata?.creationTime ?? "");
  if (!Number.isFinite(created)) return false;
  return nowMs - created > CLEANUP.MAX_AGE_MS;
}

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && code ? code.slice(0, 80) : "error";
}

/**
 * Page through every account and remove (or report) the unconfirmed password accounts older than
 * 7 days, at most 500, stopping at `deadlineMs`. Logs one line per account acted on and one summary.
 */
export async function sweepUnconfirmedAccounts(opts: { deadlineMs: number }, deps: SweepDeps = {}): Promise<SweepResult> {
  const clock = deps.clock ?? Date.now;
  const log = deps.log ?? writeLog;
  const deleting = deps.deleting ?? isPasswordCleanupDeleteEnabled();
  const result: SweepResult = { mode: deleting ? "delete" : "log_only", pages: 0, scanned: 0, deleted: 0, wouldDelete: 0, gone: 0, failed: 0, partial: false };
  const started = clock();
  let acted = 0;
  try {
    const auth = deps.auth ?? adminAuth();
    let pageToken: string | undefined;
    let stop = false;
    do {
      if (clock() >= opts.deadlineMs) {
        result.partial = true;
        break;
      }
      const page = await auth.listUsers(CLEANUP.PAGE_SIZE, pageToken);
      result.pages += 1;
      result.scanned += page.users.length;
      for (const user of page.users) {
        if (!isUnconfirmedPasswordAccount(user, started)) continue;
        if (acted >= CLEANUP.MAX_PER_RUN || clock() >= opts.deadlineMs) {
          result.partial = true;
          stop = true;
          break;
        }
        acted += 1;
        let outcome: SweepOutcome = "would_delete";
        let error: string | undefined;
        if (deleting) {
          try {
            await auth.deleteUser(user.uid);
            outcome = "deleted";
          } catch (err) {
            error = errorCode(err);
            outcome = error === "auth/user-not-found" ? "gone" : "failed";
          }
        }
        if (outcome === "deleted") result.deleted += 1;
        else if (outcome === "would_delete") result.wouldDelete += 1;
        else if (outcome === "gone") result.gone += 1;
        else result.failed += 1;
        const created = Date.parse(user.metadata.creationTime);
        log({
          severity: outcome === "failed" ? "WARNING" : "INFO",
          message: `[auth] unconfirmed password account ${outcome}`,
          event: SWEEP_EVENT,
          outcome,
          uid: user.uid,
          domain: emailDomain(user.email),
          ageDays: Math.floor((started - created) / 86_400_000),
          ...(outcome === "failed" && error ? { error } : {}),
        });
      }
      pageToken = page.pageToken;
    } while (pageToken && !stop);
  } catch (err) {
    result.error = errorCode(err);
  }
  log({
    severity: result.error || result.failed ? "WARNING" : "INFO",
    message: `[auth] unconfirmed sweep (${result.mode}): ${result.scanned} accounts looked at, ${result.deleted} deleted, ${result.wouldDelete} would delete, ${result.gone} gone, ${result.failed} failed${result.partial ? ", stopped early" : ""}${result.error ? `, list failed: ${result.error}` : ""}`,
    event: SWEEP_SUMMARY_EVENT,
    ...result,
    ms: clock() - started,
  });
  return result;
}

/**
 * The tick's entry: runs the sweep while PASSWORD_SIGNIN_ENABLED is on, when there is time left and
 * no other instance has run it this hour. Null when it didn't run.
 */
export async function runAuthCleanup(opts: { deadlineMs: number }, deps: CleanupRunDeps = {}): Promise<SweepResult | null> {
  if (!isPasswordSigninEnabled()) return null;
  const clock = deps.clock ?? Date.now;
  if (opts.deadlineMs - clock() < CLEANUP.MIN_RUN_MS) return null;
  const limited = await (deps.limited ?? (() => isRateLimited(CLEANUP_RUN_SUBJECT, CLEANUP_RUN_LIMIT)))();
  if (limited) return null;
  return sweepUnconfirmedAccounts(opts, deps);
}

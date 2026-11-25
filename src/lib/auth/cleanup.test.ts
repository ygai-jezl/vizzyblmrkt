import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLEANUP,
  CLEANUP_RUN_LIMIT,
  CLEANUP_RUN_SUBJECT,
  emailDomain,
  isUnconfirmedPasswordAccount,
  runAuthCleanup,
  sweepUnconfirmedAccounts,
  SWEEP_EVENT,
  SWEEP_SUMMARY_EVENT,
  type SweepAuth,
  type SweepLogEntry,
  type SweepUser,
} from "./cleanup";

const rateLimit = vi.hoisted(() => ({ isRateLimited: vi.fn(async () => false) }));
vi.mock("@/lib/tenant/rateLimit", () => rateLimit);
const admin = vi.hoisted(() => ({ adminAuth: vi.fn(() => { throw new Error("no Auth in tests"); }) }));
vi.mock("./adminAuth", () => admin);

// The clean-up over a fake account list: which accounts it picks, what it logs, and its limits.
const NOW = Date.parse("2026-11-24T12:00:00.000Z");
const DAY = 86_400_000;
const at = (ms: number) => new Date(ms).toUTCString();

const user = (uid: string, over: Partial<SweepUser> = {}): SweepUser => ({
  uid,
  email: `${uid}@Example.com`,
  emailVerified: false,
  providerData: [{ providerId: "password" }],
  metadata: { creationTime: at(NOW - 8 * DAY) },
  ...over,
});

function fakeAuth(pages: SweepUser[][], opts: { failDelete?: Record<string, string>; failList?: boolean } = {}) {
  const deleted: string[] = [];
  const auth: SweepAuth & { listUsers: ReturnType<typeof vi.fn>; deleteUser: ReturnType<typeof vi.fn> } = {
    listUsers: vi.fn(async (_max: number, token?: string) => {
      if (opts.failList) throw Object.assign(new Error("boom for someone@example.com"), { code: "auth/internal-error" });
      const i = token ? Number(token) : 0;
      return { users: pages[i] ?? [], ...(i + 1 < pages.length ? { pageToken: String(i + 1) } : {}) };
    }),
    deleteUser: vi.fn(async (uid: string) => {
      const code = opts.failDelete?.[uid];
      if (code) throw Object.assign(new Error(`failed for ${uid}@example.com`), { code });
      deleted.push(uid);
    }),
  };
  return { auth, deleted };
}

let logs: SweepLogEntry[];
const log = (e: SweepLogEntry) => logs.push(e);
const perAccount = () => logs.filter((l) => l.event === SWEEP_EVENT);
const summary = () => logs.filter((l) => l.event === SWEEP_SUMMARY_EVENT);

beforeEach(() => {
  logs = [];
  vi.clearAllMocks();
  vi.stubEnv("PASSWORD_SIGNIN_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("which accounts the clean-up picks", () => {
  it("takes an unverified password account older than 7 days with no tenant claim", () => {
    expect(isUnconfirmedPasswordAccount(user("u1"), NOW)).toBe(true);
  });

  it("keeps verified, Google only, young, claimed, and undated accounts", () => {
    expect(isUnconfirmedPasswordAccount(user("u1", { emailVerified: true }), NOW)).toBe(false);
    expect(isUnconfirmedPasswordAccount(user("u1", { providerData: [{ providerId: "google.com" }] }), NOW)).toBe(false);
    expect(isUnconfirmedPasswordAccount(user("u1", { providerData: [] }), NOW)).toBe(false);
    expect(isUnconfirmedPasswordAccount(user("u1", { metadata: { creationTime: at(NOW - 6 * DAY) } }), NOW)).toBe(false);
    expect(isUnconfirmedPasswordAccount(user("u1", { metadata: { creationTime: at(NOW - CLEANUP.MAX_AGE_MS) } }), NOW)).toBe(false);
    expect(isUnconfirmedPasswordAccount(user("u1", { customClaims: { tenant_id: "ten_a", role: "admin" } }), NOW)).toBe(false);
    // Any tenant_id claim keeps the account, even an empty one.
    expect(isUnconfirmedPasswordAccount(user("u1", { customClaims: { tenant_id: null } }), NOW)).toBe(false);
    expect(isUnconfirmedPasswordAccount(user("u1", { metadata: { creationTime: "" } }), NOW)).toBe(false);
  });

  it("takes an account with other claims but no tenant claim, and one with Google linked too", () => {
    expect(isUnconfirmedPasswordAccount(user("u1", { customClaims: { something: true } }), NOW)).toBe(true);
    expect(isUnconfirmedPasswordAccount(user("u1", { providerData: [{ providerId: "google.com" }, { providerId: "password" }] }), NOW)).toBe(true);
  });

  it("logs only the domain of an address", () => {
    expect(emailDomain("Alex.Morgan@Example.COM")).toBe("example.com");
    expect(emailDomain("odd@name@example.test")).toBe("example.test");
    expect(emailDomain(undefined)).toBe("unknown");
    expect(emailDomain("no-at-sign")).toBe("unknown");
    expect(emailDomain("trailing@")).toBe("unknown");
  });
});

describe("the sweep", () => {
  it("with deletion off, only logs would_delete and deletes nothing", async () => {
    const { auth } = fakeAuth([[user("u1"), user("u2", { emailVerified: true }), user("u3", { metadata: { creationTime: at(NOW - DAY) } })]]);
    const r = await sweepUnconfirmedAccounts({ deadlineMs: NOW + 10_000 }, { auth, clock: () => NOW, log });
    expect(r).toEqual({ mode: "log_only", pages: 1, scanned: 3, deleted: 0, wouldDelete: 1, gone: 0, failed: 0, partial: false });
    expect(auth.deleteUser).not.toHaveBeenCalled();
    expect(perAccount()).toEqual([
      expect.objectContaining({ event: SWEEP_EVENT, outcome: "would_delete", uid: "u1", domain: "example.com", ageDays: 8, severity: "INFO" }),
    ]);
    expect(summary()).toHaveLength(1);
    expect(summary()[0]).toMatchObject({ mode: "log_only", scanned: 3, wouldDelete: 1, partial: false });
  });

  it("reads deletion from its switch, which needs password sign-in on too", async () => {
    const { auth } = fakeAuth([[user("u1")]]);
    vi.stubEnv("PASSWORD_CLEANUP_DELETE_ENABLED", "true");
    vi.stubEnv("PASSWORD_SIGNIN_ENABLED", "false");
    expect((await sweepUnconfirmedAccounts({ deadlineMs: NOW + 10_000 }, { auth, clock: () => NOW, log })).mode).toBe("log_only");
    expect(auth.deleteUser).not.toHaveBeenCalled();
    vi.stubEnv("PASSWORD_SIGNIN_ENABLED", "true");
    expect(await sweepUnconfirmedAccounts({ deadlineMs: NOW + 10_000 }, { auth, clock: () => NOW, log })).toMatchObject({ mode: "delete", deleted: 1 });
    expect(auth.deleteUser).toHaveBeenCalledWith("u1");
  });

  it("with deletion on, deletes every candidate across pages and keeps everyone else", async () => {
    const { auth, deleted } = fakeAuth([
      [user("a1"), user("keep1", { customClaims: { tenant_id: "ten_a" } })],
      [user("keep2", { emailVerified: true }), user("a2", { email: "x@other.test" })],
      [user("a3")],
    ]);
    const r = await sweepUnconfirmedAccounts({ deadlineMs: NOW + 10_000 }, { auth, clock: () => NOW, log, deleting: true });
    expect(deleted).toEqual(["a1", "a2", "a3"]);
    expect(r).toMatchObject({ mode: "delete", pages: 3, scanned: 5, deleted: 3, failed: 0, partial: false });
    expect(auth.listUsers.mock.calls).toEqual([[1000, undefined], [1000, "1"], [1000, "2"]]);
    expect(perAccount().map((l) => [l.uid, l.outcome, l.domain])).toEqual([
      ["a1", "deleted", "example.com"],
      ["a2", "deleted", "other.test"],
      ["a3", "deleted", "example.com"],
    ]);
  });

  it("never logs an address, even from an error", async () => {
    const { auth } = fakeAuth([[user("u1"), user("u2")]], { failDelete: { u2: "auth/internal-error" } });
    await sweepUnconfirmedAccounts({ deadlineMs: NOW + 10_000 }, { auth, clock: () => NOW, log, deleting: true });
    const failing = fakeAuth([[user("u1")]], { failList: true });
    await sweepUnconfirmedAccounts({ deadlineMs: NOW + 10_000 }, { auth: failing.auth, clock: () => NOW, log, deleting: true });
    const text = JSON.stringify(logs);
    expect(text).not.toMatch(/u1@|u2@|someone@|@example\.com/i);
  });

  it("counts a failed delete and an account already gone, and carries on", async () => {
    const { auth, deleted } = fakeAuth([[user("u1"), user("u2"), user("u3")]], {
      failDelete: { u1: "auth/internal-error", u2: "auth/user-not-found" },
    });
    const r = await sweepUnconfirmedAccounts({ deadlineMs: NOW + 10_000 }, { auth, clock: () => NOW, log, deleting: true });
    expect(deleted).toEqual(["u3"]);
    expect(r).toMatchObject({ deleted: 1, gone: 1, failed: 1 });
    expect(perAccount()[0]).toMatchObject({ uid: "u1", outcome: "failed", error: "auth/internal-error", severity: "WARNING" });
    expect(perAccount()[1]).toMatchObject({ uid: "u2", outcome: "gone", severity: "INFO" });
    expect(perAccount()[1]).not.toHaveProperty("error");
    expect(summary()[0]).toMatchObject({ severity: "WARNING", failed: 1 });
  });

  it("acts on at most 500 accounts a run, in either mode", async () => {
    const many = Array.from({ length: 1000 }, (_, i) => user(`u${i}`));
    const on = fakeAuth([many, [user("later")]]);
    const r = await sweepUnconfirmedAccounts({ deadlineMs: NOW + 10_000 }, { auth: on.auth, clock: () => NOW, log, deleting: true });
    expect(r).toMatchObject({ deleted: 500, partial: true, pages: 1 });
    expect(on.deleted).toHaveLength(500);
    expect(on.auth.listUsers).toHaveBeenCalledTimes(1);

    logs = [];
    const off = fakeAuth([many]);
    expect(await sweepUnconfirmedAccounts({ deadlineMs: NOW + 10_000 }, { auth: off.auth, clock: () => NOW, log, deleting: false })).toMatchObject({
      wouldDelete: 500,
      partial: true,
    });
    expect(perAccount()).toHaveLength(500);
  });

  it("stops at its deadline, between accounts and before the next page", async () => {
    let t = NOW;
    const clock = () => t;
    const { auth, deleted } = fakeAuth([[user("u1"), user("u2"), user("u3")], [user("u4")]]);
    auth.deleteUser.mockImplementation(async (uid: string) => {
      deleted.push(uid);
      t += 4_000;
    });
    const r = await sweepUnconfirmedAccounts({ deadlineMs: NOW + 6_000 }, { auth, clock, log, deleting: true });
    expect(deleted).toEqual(["u1", "u2"]);
    expect(r).toMatchObject({ deleted: 2, partial: true, pages: 1 });

    // Out of time after a page: the next page isn't read.
    t = NOW;
    const paged = fakeAuth([[user("keep", { emailVerified: true })], [user("u9")]]);
    paged.auth.listUsers.mockImplementationOnce(async () => {
      t += 7_000;
      return { users: [user("keep", { emailVerified: true })], pageToken: "1" };
    });
    expect(await sweepUnconfirmedAccounts({ deadlineMs: NOW + 6_000 }, { auth: paged.auth, clock, log, deleting: true })).toMatchObject({
      pages: 1,
      deleted: 0,
      partial: true,
    });
    expect(paged.auth.listUsers).toHaveBeenCalledTimes(1);
  });

  it("does nothing past its deadline, and is not partial with nothing left to read", async () => {
    const { auth } = fakeAuth([[user("u1")]]);
    expect(await sweepUnconfirmedAccounts({ deadlineMs: NOW }, { auth, clock: () => NOW, log, deleting: true })).toMatchObject({ pages: 0, partial: true });
    expect(auth.listUsers).not.toHaveBeenCalled();
    const empty = fakeAuth([[]]);
    expect(await sweepUnconfirmedAccounts({ deadlineMs: NOW + 1 }, { auth: empty.auth, clock: () => NOW, log })).toMatchObject({ pages: 1, scanned: 0, partial: false });
  });

  it("reports a failed account list in its summary instead of throwing", async () => {
    const { auth } = fakeAuth([], { failList: true });
    const r = await sweepUnconfirmedAccounts({ deadlineMs: NOW + 10_000 }, { auth, clock: () => NOW, log, deleting: true });
    expect(r).toMatchObject({ error: "auth/internal-error", deleted: 0 });
    expect(summary()[0]).toMatchObject({ severity: "WARNING", error: "auth/internal-error" });
  });

  it("writes JSON lines by default, with the per-account event", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { auth } = fakeAuth([[user("u1")]]);
    await sweepUnconfirmedAccounts({ deadlineMs: NOW + 10_000 }, { auth, clock: () => NOW, deleting: false });
    const lines = info.mock.calls.map(([line]) => JSON.parse(String(line)) as SweepLogEntry);
    expect(lines.map((l) => l.event)).toEqual([SWEEP_EVENT, SWEEP_SUMMARY_EVENT]);
    expect(lines[0]).toMatchObject({ severity: "INFO", outcome: "would_delete", domain: "example.com" });
    info.mockRestore();
  });
});

describe("the hourly run", () => {
  it("does nothing with password sign-in off: no gate checked, no account read", async () => {
    vi.stubEnv("PASSWORD_SIGNIN_ENABLED", "false");
    vi.stubEnv("PASSWORD_CLEANUP_DELETE_ENABLED", "true");
    const { auth } = fakeAuth([[user("u1")]]);
    expect(await runAuthCleanup({ deadlineMs: NOW + 10_000 }, { auth, clock: () => NOW, log })).toBeNull();
    expect(rateLimit.isRateLimited).not.toHaveBeenCalled();
    expect(auth.listUsers).not.toHaveBeenCalled();
  });

  it("runs once an hour across instances through the shared rate limit", async () => {
    const { auth } = fakeAuth([[user("u1")]]);
    expect(await runAuthCleanup({ deadlineMs: NOW + 10_000 }, { auth, clock: () => NOW, log })).toMatchObject({ mode: "log_only", wouldDelete: 1 });
    expect(rateLimit.isRateLimited).toHaveBeenCalledWith(CLEANUP_RUN_SUBJECT, CLEANUP_RUN_LIMIT);
    expect(CLEANUP_RUN_SUBJECT).toBe("auth-cleanup");
    expect(CLEANUP_RUN_LIMIT).toEqual({ prefix: "auth-cleanup-run", burstLimit: 1, hourlyLimit: 1 });

    rateLimit.isRateLimited.mockResolvedValueOnce(true);
    auth.listUsers.mockClear();
    expect(await runAuthCleanup({ deadlineMs: NOW + 10_000 }, { auth, clock: () => NOW, log })).toBeNull();
    expect(auth.listUsers).not.toHaveBeenCalled();
  });

  it("doesn't use up its hour with too little time left", async () => {
    const { auth } = fakeAuth([[user("u1")]]);
    const limited = vi.fn(async () => false);
    expect(await runAuthCleanup({ deadlineMs: NOW + CLEANUP.MIN_RUN_MS - 1 }, { auth, clock: () => NOW, log, limited })).toBeNull();
    expect(limited).not.toHaveBeenCalled();
    expect(await runAuthCleanup({ deadlineMs: NOW + CLEANUP.MIN_RUN_MS }, { auth, clock: () => NOW, log, limited })).not.toBeNull();
    expect(limited).toHaveBeenCalledTimes(1);
  });

  it("deletes with both switches on", async () => {
    vi.stubEnv("PASSWORD_CLEANUP_DELETE_ENABLED", "true");
    const { auth, deleted } = fakeAuth([[user("u1")]]);
    expect(await runAuthCleanup({ deadlineMs: NOW + 10_000 }, { auth, clock: () => NOW, log })).toMatchObject({ mode: "delete", deleted: 1 });
    expect(deleted).toEqual(["u1"]);
  });

  it("uses the server's Auth client by default, and a failure to start it is reported, not thrown", async () => {
    const r = await runAuthCleanup({ deadlineMs: NOW + 10_000 }, { clock: () => NOW, log });
    expect(admin.adminAuth).toHaveBeenCalled();
    expect(r).toMatchObject({ error: "error", pages: 0 });
  });
});

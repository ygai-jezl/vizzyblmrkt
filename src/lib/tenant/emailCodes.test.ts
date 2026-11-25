import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import { TenantValidationError } from "./errors";
import {
  checkEmailCode,
  checkEmailLink,
  claimEmailCodeSend,
  deleteEmailCode,
  deleteEmailLink,
  EMAIL_CODE_GUARDS,
  EMAIL_CODE_MAX_TRIES,
  EMAIL_CODE_SENDS_PER_HOUR,
  EMAIL_CODE_VALID_MS,
  EMAIL_CODE_WRONG_PER_DAY,
  EMAIL_CODES,
  EMAIL_LINK_VALID_MS,
  EMAIL_LINKS,
  putEmailCode,
  putEmailLink,
} from "./emailCodes";

const UID = "uidAlexExample0001";
const T0 = new Date("2026-11-24T10:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const RIGHT = hash("right");
const WRONG = hash("wrong");
/** The address's key: its SHA-256, never the address. */
const ADDR = hash("alex@example.com");

let db: FakeFirestore;
beforeEach(() => {
  db = new FakeFirestore();
});

describe("email codes", () => {
  it("store only the hash, with a 10 minute expiry and a Date time to live", async () => {
    await putEmailCode(UID, RIGHT, { now: T0, db });
    expect(db.raw(EMAIL_CODES, UID)).toEqual({
      hash: RIGHT,
      attempts: 0,
      createdAt: "2026-11-24T10:00:00.000Z",
      expiresAt: "2026-11-24T10:10:00.000Z",
      ttl: new Date("2026-11-24T10:10:00.000Z"),
    });
    expect(EMAIL_CODE_VALID_MS).toBe(600_000);
    expect(EMAIL_CODE_MAX_TRIES).toBe(5);
  });

  it("accept the matching hash and keep the code until it is deleted", async () => {
    await putEmailCode(UID, RIGHT, { now: T0, db });
    expect(await checkEmailCode(UID, RIGHT, { addressKey: ADDR, now: at(60_000), db })).toEqual({ ok: true });
    expect(db.raw(EMAIL_CODES, UID)).toBeDefined();
    await deleteEmailCode(UID, { db });
    expect(db.raw(EMAIL_CODES, UID)).toBeUndefined();
    expect(await checkEmailCode(UID, RIGHT, { addressKey: ADDR, now: at(61_000), db })).toEqual({ ok: false, why: "missing" });
  });

  it("count wrong tries down, and the fifth deletes the code", async () => {
    await putEmailCode(UID, RIGHT, { now: T0, db });
    const left: number[] = [];
    for (let i = 0; i < EMAIL_CODE_MAX_TRIES - 1; i += 1) {
      const r = await checkEmailCode(UID, WRONG, { addressKey: ADDR, now: at(1000), db });
      if (r.ok || r.why !== "wrong") throw new Error(`expected wrong, got ${JSON.stringify(r)}`);
      left.push(r.attemptsLeft);
    }
    expect(left).toEqual([4, 3, 2, 1]);
    expect(db.raw(EMAIL_CODES, UID)!.attempts).toBe(4);
    expect(await checkEmailCode(UID, WRONG, { addressKey: ADDR, now: at(1000), db })).toEqual({ ok: false, why: "too_many" });
    expect(db.raw(EMAIL_CODES, UID)).toBeUndefined();
    // Even the right code is gone now.
    expect(await checkEmailCode(UID, RIGHT, { addressKey: ADDR, now: at(1000), db })).toEqual({ ok: false, why: "missing" });
  });

  it("refuse an expired code and delete it", async () => {
    await putEmailCode(UID, RIGHT, { now: T0, db });
    expect(await checkEmailCode(UID, RIGHT, { addressKey: ADDR, now: at(EMAIL_CODE_VALID_MS), db })).toEqual({ ok: false, why: "expired" });
    expect(db.raw(EMAIL_CODES, UID)).toBeUndefined();
  });

  it("refuse a stored code that already used its tries", async () => {
    db.seed(EMAIL_CODES, UID, { hash: RIGHT, attempts: 5, expiresAt: at(60_000).toISOString() });
    expect(await checkEmailCode(UID, RIGHT, { addressKey: ADDR, now: T0, db })).toEqual({ ok: false, why: "too_many" });
    expect(db.raw(EMAIL_CODES, UID)).toBeUndefined();
  });

  it("replace the old code and its tries on a new send", async () => {
    await putEmailCode(UID, RIGHT, { now: T0, db });
    await checkEmailCode(UID, WRONG, { addressKey: ADDR, now: at(1000), db });
    const next = hash("next");
    await putEmailCode(UID, next, { now: at(30_000), db });
    expect(db.raw(EMAIL_CODES, UID)).toMatchObject({ hash: next, attempts: 0, expiresAt: "2026-11-24T10:10:30.000Z" });
    expect(await checkEmailCode(UID, RIGHT, { addressKey: ADDR, now: at(31_000), db })).toEqual({ ok: false, why: "wrong", attemptsLeft: 4 });
    expect(await checkEmailCode(UID, next, { addressKey: ADDR, now: at(32_000), db })).toEqual({ ok: true });
  });

  it("keep accounts apart", async () => {
    await putEmailCode(UID, RIGHT, { now: T0, db });
    expect(await checkEmailCode("uidSamExample0002", RIGHT, { addressKey: ADDR, now: at(1000), db })).toEqual({ ok: false, why: "missing" });
  });

  it("count every one of several tries racing each other", async () => {
    await putEmailCode(UID, RIGHT, { now: T0, db });
    db.onBeforeCommit = async () => {
      await checkEmailCode(UID, WRONG, { addressKey: ADDR, now: at(1000), db });
    };
    const r = await checkEmailCode(UID, WRONG, { addressKey: ADDR, now: at(1000), db });
    expect(r).toEqual({ ok: false, why: "wrong", attemptsLeft: 3 });
    expect(db.raw(EMAIL_CODES, UID)!.attempts).toBe(2);
  });

  it("treat a malformed stored record as no code", async () => {
    db.seed(EMAIL_CODES, UID, { hash: "not-a-hash", attempts: 0, expiresAt: at(60_000).toISOString() });
    expect(await checkEmailCode(UID, RIGHT, { addressKey: ADDR, now: T0, db })).toEqual({ ok: false, why: "missing" });
  });

  it("refuse a bad user id or hash", async () => {
    for (const uid of ["", "a/b", "..", "__x__", "x".repeat(129)]) {
      await expect(putEmailCode(uid, RIGHT, { db })).rejects.toBeInstanceOf(TenantValidationError);
      await expect(checkEmailCode(uid, RIGHT, { addressKey: ADDR, db })).rejects.toBeInstanceOf(TenantValidationError);
    }
    await expect(putEmailCode(UID, "123456", { db })).rejects.toBeInstanceOf(TenantValidationError);
    await expect(checkEmailCode(UID, RIGHT.toUpperCase(), { addressKey: ADDR, db })).rejects.toBeInstanceOf(TenantValidationError);
    await expect(checkEmailCode(UID, RIGHT, { addressKey: "alex@example.com", db })).rejects.toBeInstanceOf(TenantValidationError);
    await expect(claimEmailCodeSend("alex@example.com", { db })).rejects.toBeInstanceOf(TenantValidationError);
    expect(db.dump(EMAIL_CODES)).toEqual([]);
  });
});

describe("the per address guard", () => {
  it("allows 6 sends an hour, then refuses until the oldest is an hour old", async () => {
    expect(EMAIL_CODE_SENDS_PER_HOUR).toBe(6);
    for (let i = 0; i < 6; i += 1) expect(await claimEmailCodeSend(ADDR, { now: at(i * 60_000), db })).toBe("ok");
    expect(await claimEmailCodeSend(ADDR, { now: at(30 * 60_000), db })).toBe("too_many_sends");
    expect(await claimEmailCodeSend(ADDR, { now: at(60 * 60_000 + 1), db })).toBe("ok");
    const stored = db.raw(EMAIL_CODE_GUARDS, ADDR)!;
    expect(stored.sends).toHaveLength(6);
    expect(stored.ttl).toBeInstanceOf(Date);
    expect(await claimEmailCodeSend(hash("sam@example.com"), { now: at(30 * 60_000), db })).toBe("ok");
  });

  it("counts wrong tries across new codes and accounts, and shuts the address out for a day after 15", async () => {
    expect(EMAIL_CODE_WRONG_PER_DAY).toBe(15);
    let wrong = 0;
    // A new code (and here a new account) each time resets the code's own tries, not the address's.
    for (let round = 0; wrong < EMAIL_CODE_WRONG_PER_DAY; round += 1) {
      const uid = `uidAlexRound${round}`;
      await putEmailCode(uid, RIGHT, { now: at(round * 60_000), db });
      for (let i = 0; i < 4 && wrong < EMAIL_CODE_WRONG_PER_DAY; i += 1) {
        const r = await checkEmailCode(uid, WRONG, { addressKey: ADDR, now: at(round * 60_000 + 1000), db });
        wrong += 1;
        // The wrong try that shuts the address out says so, once.
        if (wrong === EMAIL_CODE_WRONG_PER_DAY) expect(r).toEqual({ ok: false, why: "locked", justLocked: true });
      }
    }
    expect(db.raw(EMAIL_CODE_GUARDS, ADDR)!.wrong).toHaveLength(15);
    // Shut out: no new code, and a code already stored can't be checked, even the right one.
    expect(await claimEmailCodeSend(ADDR, { now: at(2 * 60 * 60_000), db })).toBe("shut_out");
    await putEmailCode(UID, RIGHT, { now: at(2 * 60 * 60_000), db });
    expect(await checkEmailCode(UID, RIGHT, { addressKey: ADDR, now: at(2 * 60 * 60_000 + 1000), db })).toEqual({
      ok: false,
      why: "locked",
      justLocked: false,
    });
    expect(db.raw(EMAIL_CODES, UID)).toBeUndefined();
    // With no code stored at all, the answer is still locked, not missing.
    expect(await checkEmailCode(UID, RIGHT, { addressKey: ADDR, now: at(2 * 60 * 60_000 + 2000), db })).toEqual({
      ok: false,
      why: "locked",
      justLocked: false,
    });
    expect(db.raw(EMAIL_CODE_GUARDS, ADDR)!.wrong).toHaveLength(15);
    // Another address is untouched, and a day later this one can ask again.
    expect(await claimEmailCodeSend(hash("sam@example.com"), { now: at(2 * 60 * 60_000), db })).toBe("ok");
    expect(await claimEmailCodeSend(ADDR, { now: at(25 * 60 * 60_000), db })).toBe("ok");
  });

  it("keeps entries from requests that started later but committed first", async () => {
    // A send that took its time at T0 commits after wrong tries stamped later: they still count.
    await putEmailCode(UID, RIGHT, { now: T0, db });
    for (let i = 1; i <= 4; i += 1) await checkEmailCode(UID, WRONG, { addressKey: ADDR, now: at(i * 1000), db });
    expect(await claimEmailCodeSend(ADDR, { now: T0, db })).toBe("ok");
    expect(db.raw(EMAIL_CODE_GUARDS, ADDR)!.wrong).toHaveLength(4);
    // A wrong try that started before a later one but commits after it keeps the later one too.
    await putEmailCode(UID, RIGHT, { now: T0, db });
    await checkEmailCode(UID, WRONG, { addressKey: ADDR, now: at(6000), db });
    await checkEmailCode(UID, WRONG, { addressKey: ADDR, now: at(5000), db });
    const stored = db.raw(EMAIL_CODE_GUARDS, ADDR)!;
    expect(stored.wrong).toHaveLength(6);
    expect(stored.sends).toEqual([T0.getTime()]);
    expect(stored.ttl).toEqual(new Date(at(6000).getTime() + 24 * 60 * 60_000));
  });

  it("can't be bypassed by sending a new code between racing wrong tries", async () => {
    // Each round: a send whose clock was read first, then wrong tries that commit before it.
    let checks = 0;
    let shutOut = false;
    for (let round = 0; round < 10 && !shutOut; round += 1) {
      const start = round * 10 * 60_000;
      await putEmailCode(UID, RIGHT, { now: at(start), db });
      for (let i = 1; i <= 4; i += 1) {
        const r = await checkEmailCode(UID, WRONG, { addressKey: ADDR, now: at(start + i * 10), db });
        checks += 1;
        if (r.ok === false && r.why === "locked") shutOut = true;
      }
      if (round < 3) expect(await claimEmailCodeSend(ADDR, { now: at(start), db })).toBe("ok");
      else expect(await claimEmailCodeSend(ADDR, { now: at(start), db })).not.toBe("ok");
    }
    expect(checks).toBeLessThanOrEqual(EMAIL_CODE_WRONG_PER_DAY + 1);
    expect(db.raw(EMAIL_CODE_GUARDS, ADDR)!.wrong).toHaveLength(EMAIL_CODE_WRONG_PER_DAY);
  });

  it("doesn't count a right code, a missing one or an expired one", async () => {
    await checkEmailCode(UID, RIGHT, { addressKey: ADDR, now: T0, db });
    await putEmailCode(UID, RIGHT, { now: T0, db });
    await checkEmailCode(UID, WRONG, { addressKey: ADDR, now: at(EMAIL_CODE_VALID_MS), db });
    await putEmailCode(UID, RIGHT, { now: T0, db });
    expect(await checkEmailCode(UID, RIGHT, { addressKey: ADDR, now: at(1000), db })).toEqual({ ok: true });
    expect(db.raw(EMAIL_CODE_GUARDS, ADDR)).toBeUndefined();
  });
});

describe("the lock and links", () => {
  /** Shuts the address out with 15 wrong tries over 4 codes, each a minute apart. */
  async function lockOut(): Promise<void> {
    for (let i = 0; i < EMAIL_CODE_WRONG_PER_DAY; i += 1) {
      if (i % 4 === 0) await putEmailCode(UID, RIGHT, { now: at(i * 1000), db });
      await checkEmailCode(UID, WRONG, { addressKey: ADDR, now: at(i * 1000 + 500), db });
    }
  }

  it("says justLocked for exactly one wrong try per lock, even with tries racing", async () => {
    let justLocked = 0;
    for (let i = 0; i < EMAIL_CODE_WRONG_PER_DAY - 1; i += 1) {
      if (i % 4 === 0) await putEmailCode(UID, RIGHT, { now: at(i * 1000), db });
      await checkEmailCode(UID, WRONG, { addressKey: ADDR, now: at(i * 1000 + 500), db });
    }
    await putEmailCode(UID, RIGHT, { now: at(20_000), db });
    // Two tries race for the fifteenth: one commits first, the other runs again and finds the lock.
    db.onBeforeCommit = async () => {
      db.onBeforeCommit = undefined;
      const r = await checkEmailCode(UID, WRONG, { addressKey: ADDR, now: at(21_000), db });
      if (!r.ok && r.why === "locked" && r.justLocked) justLocked += 1;
    };
    const r = await checkEmailCode(UID, WRONG, { addressKey: ADDR, now: at(21_000), db });
    if (!r.ok && r.why === "locked" && r.justLocked) justLocked += 1;
    expect(r).toMatchObject({ ok: false, why: "locked" });
    expect(justLocked).toBe(1);
    expect(db.raw(EMAIL_CODE_GUARDS, ADDR)!.wrong).toHaveLength(15);
  });

  it("lets a link be sent while the address is shut out of codes", async () => {
    await lockOut();
    expect(await claimEmailCodeSend(ADDR, { now: at(60_000), db })).toBe("shut_out");
    expect(await claimEmailCodeSend(ADDR, { now: at(60_000), db, via: "link" })).toBe("ok");
    expect(await claimEmailCodeSend(ADDR, { now: at(61_000), db, via: "code" })).toBe("shut_out");
  });

  it("counts link sends toward the address's 6 sends an hour, with codes", async () => {
    for (let i = 0; i < 3; i += 1) expect(await claimEmailCodeSend(ADDR, { now: at(i * 1000), db })).toBe("ok");
    for (let i = 3; i < 6; i += 1) expect(await claimEmailCodeSend(ADDR, { now: at(i * 1000), db, via: "link" })).toBe("ok");
    expect(await claimEmailCodeSend(ADDR, { now: at(10_000), db, via: "link" })).toBe("too_many_sends");
    expect(await claimEmailCodeSend(ADDR, { now: at(10_000), db })).toBe("too_many_sends");
    expect(db.raw(EMAIL_CODE_GUARDS, ADDR)!.sends).toHaveLength(6);
  });

  it("store only the link's hash, with a 30 minute expiry and a Date time to live", async () => {
    expect(EMAIL_LINK_VALID_MS).toBe(30 * 60_000);
    await putEmailLink(UID, RIGHT, { now: T0, db });
    expect(db.raw(EMAIL_LINKS, UID)).toEqual({
      hash: RIGHT,
      createdAt: "2026-11-24T10:00:00.000Z",
      expiresAt: "2026-11-24T10:30:00.000Z",
      ttl: new Date("2026-11-24T10:30:00.000Z"),
    });
  });

  it("accept the matching link until it is deleted, so it works once", async () => {
    await putEmailLink(UID, RIGHT, { now: T0, db });
    expect(await checkEmailLink(UID, RIGHT, { now: at(29 * 60_000), db })).toEqual({ ok: true });
    expect(db.raw(EMAIL_LINKS, UID)).toBeDefined();
    await deleteEmailLink(UID, { db });
    expect(await checkEmailLink(UID, RIGHT, { now: at(29 * 60_000), db })).toEqual({ ok: false, why: "missing" });
  });

  it("refuse another link and change nothing, with no count of tries", async () => {
    await putEmailLink(UID, RIGHT, { now: T0, db });
    for (let i = 0; i < 20; i += 1) expect(await checkEmailLink(UID, WRONG, { now: at(1000), db })).toEqual({ ok: false, why: "wrong" });
    expect(await checkEmailLink(UID, RIGHT, { now: at(2000), db })).toEqual({ ok: true });
    expect(db.raw(EMAIL_CODE_GUARDS, ADDR)).toBeUndefined();
  });

  it("refuse an expired link and delete it", async () => {
    await putEmailLink(UID, RIGHT, { now: T0, db });
    expect(await checkEmailLink(UID, RIGHT, { now: at(EMAIL_LINK_VALID_MS), db })).toEqual({ ok: false, why: "expired" });
    expect(db.raw(EMAIL_LINKS, UID)).toBeUndefined();
  });

  it("replace the old link on a new send", async () => {
    await putEmailLink(UID, RIGHT, { now: T0, db });
    const next = hash("next");
    await putEmailLink(UID, next, { now: at(60_000), db });
    expect(await checkEmailLink(UID, RIGHT, { now: at(61_000), db })).toEqual({ ok: false, why: "wrong" });
    expect(await checkEmailLink(UID, next, { now: at(61_000), db })).toEqual({ ok: true });
  });

  it("keep codes and links apart: neither a new code nor a new link touches the other", async () => {
    const link = hash("link");
    await putEmailCode(UID, RIGHT, { now: T0, db });
    await putEmailLink(UID, link, { now: at(1000), db });
    await putEmailCode(UID, RIGHT, { now: at(2000), db });
    expect(await checkEmailLink(UID, link, { now: at(3000), db })).toEqual({ ok: true });
    expect(await checkEmailCode(UID, RIGHT, { addressKey: ADDR, now: at(3000), db })).toEqual({ ok: true });
    await deleteEmailLink(UID, { db });
    expect(db.raw(EMAIL_CODES, UID)).toBeDefined();
  });

  it("work while the address is shut out of codes", async () => {
    await lockOut();
    await putEmailLink(UID, RIGHT, { now: at(60_000), db });
    expect(await checkEmailLink(UID, RIGHT, { now: at(61_000), db })).toEqual({ ok: true });
  });

  it("keep accounts apart, and treat a malformed stored link as none", async () => {
    await putEmailLink(UID, RIGHT, { now: T0, db });
    expect(await checkEmailLink("uidSamExample0002", RIGHT, { now: at(1000), db })).toEqual({ ok: false, why: "missing" });
    db.seed(EMAIL_LINKS, UID, { hash: "not-a-hash", expiresAt: at(60_000).toISOString() });
    expect(await checkEmailLink(UID, RIGHT, { now: T0, db })).toEqual({ ok: false, why: "missing" });
  });

  it("refuse a bad user id or hash", async () => {
    for (const uid of ["", "a/b", "..", "__x__", "x".repeat(129)]) {
      await expect(putEmailLink(uid, RIGHT, { db })).rejects.toBeInstanceOf(TenantValidationError);
      await expect(checkEmailLink(uid, RIGHT, { db })).rejects.toBeInstanceOf(TenantValidationError);
      await expect(deleteEmailLink(uid, { db })).rejects.toBeInstanceOf(TenantValidationError);
    }
    await expect(putEmailLink(UID, "a-plain-token", { db })).rejects.toBeInstanceOf(TenantValidationError);
    await expect(checkEmailLink(UID, RIGHT.toUpperCase(), { db })).rejects.toBeInstanceOf(TenantValidationError);
    expect(db.dump(EMAIL_LINKS)).toEqual([]);
  });
});

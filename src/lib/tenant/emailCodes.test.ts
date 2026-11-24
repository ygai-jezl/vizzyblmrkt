import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import { TenantValidationError } from "./errors";
import {
  checkEmailCode,
  claimEmailCodeSend,
  deleteEmailCode,
  EMAIL_CODE_GUARDS,
  EMAIL_CODE_MAX_TRIES,
  EMAIL_CODE_SENDS_PER_HOUR,
  EMAIL_CODE_VALID_MS,
  EMAIL_CODE_WRONG_PER_DAY,
  EMAIL_CODES,
  putEmailCode,
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
        if (wrong === EMAIL_CODE_WRONG_PER_DAY) expect(r).toEqual({ ok: false, why: "too_many" });
      }
    }
    expect(db.raw(EMAIL_CODE_GUARDS, ADDR)!.wrong).toHaveLength(15);
    // Shut out: no new code, and a code already stored can't be checked, even the right one.
    expect(await claimEmailCodeSend(ADDR, { now: at(2 * 60 * 60_000), db })).toBe("shut_out");
    await putEmailCode(UID, RIGHT, { now: at(2 * 60 * 60_000), db });
    expect(await checkEmailCode(UID, RIGHT, { addressKey: ADDR, now: at(2 * 60 * 60_000 + 1000), db })).toEqual({ ok: false, why: "too_many" });
    expect(db.raw(EMAIL_CODES, UID)).toBeUndefined();
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
        if (r.ok === false && r.why === "too_many") shutOut = true;
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

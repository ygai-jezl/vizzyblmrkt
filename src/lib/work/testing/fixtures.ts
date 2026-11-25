import type { NewWorkTask, WorkWrite } from "@/lib/tenant/work";
import type { WorkSource, WorkTask } from "../types";

/**
 * Made-up Work for tests: Lumen (a notes app, in the US and the EU) and Fernhill Plants. No real
 * people or brands.
 */

export const ORG = "org_ten_lumen";
export const OTHER_ORG = "org_ten_fernhill";
export const LUMEN_US = "ten_lumen";
export const LUMEN_EU = "ten_lumen-eu";
export const NINA = "uid_nina";
export const SAM = "uid_sam";
export const T0 = "2026-11-20T09:00:00.000Z";
export const T1 = "2026-11-21T09:00:00.000Z";

export const PERSON: WorkSource = { who: { kind: "person", id: NINA }, tool: "work_page", session: null };

export function aWrite(over: Partial<WorkWrite> = {}): WorkWrite {
  return { source: PERSON, at: T0, day: "2026-11-20", ...over };
}

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
let n = 0;
/** A fresh task id: `wt_` and 20 base32 characters, a different one each call. */
export function taskId(): string {
  n += 1;
  let x = n;
  let s = "";
  while (x > 0) {
    s = B32[x % 32] + s;
    x = Math.floor(x / 32);
  }
  return `wt_${s.padStart(20, "a")}`;
}

/** A new To do task for Lumen's US brand, ref 1, made by Nina. */
export function aTask(over: Partial<NewWorkTask> = {}): NewWorkTask {
  return {
    id: taskId(),
    organisationId: ORG,
    brandId: LUMEN_US,
    addedFrom: LUMEN_US,
    region: "us",
    ref: 1,
    title: "Add a G2 listing",
    description: "",
    notes: "",
    status: "todo",
    stage: "market",
    mustHave: false,
    links: [],
    blockedBy: [],
    waitingOn: null,
    ideaId: null,
    ideaBrandId: null,
    clipping: null,
    typedLinks: [],
    measure: null,
    origin: { kind: "person", by: NINA },
    check: null,
    closedAt: null,
    ...over,
  };
}

/** A stored task, as the store would keep it. */
export function aStoredTask(over: Partial<WorkTask> = {}): WorkTask {
  const base = aTask();
  return { ...base, open: true, hasCheck: false, recent: [], createdAt: T0, updatedAt: T0, ...over };
}

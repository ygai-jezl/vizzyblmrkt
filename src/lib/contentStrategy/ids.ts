import { randomBytes } from "node:crypto";

/** A new slot's id. */
export function newSlotId(): string {
  return `slt_${randomBytes(8).toString("hex")}`;
}

/** A new pillar's id. */
export function newPillarId(): string {
  return `pil_${randomBytes(8).toString("hex")}`;
}

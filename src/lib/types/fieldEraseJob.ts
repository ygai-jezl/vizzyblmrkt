import type { RecordFieldObject } from "./recordField";

/**
 * One field's erase job (Settings › History, ADR-0023), in the brand's regional `field_erase_jobs`:
 * one per brand, object and field, with a fixed id hashed from the three (fieldEraseJobId), so a
 * double click can't start two. A count is a job too: the erase can only start once a count of the
 * same field has finished since it was last archived. The lifecycle tick moves a running job on a
 * page at a time, from its cursor, while SETTINGS_ERASE_ENABLED is on. Ids, numbers and times only:
 * never a value, never an address.
 */

export type FieldEraseMode = "count" | "erase";
export type FieldEraseState = "running" | "done" | "failed" | "stopped";
/** Where a job is: people or companies, then history entries, then Vizzy's suggestions, then the field itself. */
export type FieldErasePhase = "records" | "events" | "actions" | "finish";

export interface FieldEraseCounts {
  /** People or companies that hold a value (a count), or whose value was removed (an erase). */
  records: number;
  /** History entries that name it, or that were blanked. */
  events: number;
  /** Vizzy's suggestions that hold it, or that were blanked. */
  agentActions: number;
}

export interface FieldEraseJob {
  /** `fej_` and a hash of the brand, object and field. */
  id: string;
  tenantId: string;
  fieldId: string;
  object: RecordFieldObject;
  mode: FieldEraseMode;
  state: FieldEraseState;
  cursor: { phase: FieldErasePhase; after: string | null };
  counts: FieldEraseCounts;
  /** An erase: the count it was confirmed against, and when that count finished. */
  counted: (FieldEraseCounts & { at: string }) | null;
  /** Who started it, by user id. */
  startedBy: string;
  startedAt: string;
  finishedAt: string | null;
  updatedAt: string;
  /** Records looked at so far, for progress. */
  scanned: number;
  /** A tick holds the job until then, so two ticks never run it at once. */
  leaseUntil: string | null;
  /** Steps that failed in a row; at FIELD_ERASE_MAX_FAILURES the job fails. */
  failures: number;
  /** Why it failed or stopped, as a code. */
  error: string | null;
}

export const FIELD_ERASE_MAX_FAILURES = 5;

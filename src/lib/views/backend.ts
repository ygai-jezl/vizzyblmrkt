import type { TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { RecordField } from "@/lib/types/recordField";
import type { FilterFlag } from "./conditions";
import { memoryBackend } from "./source";
import type { ViewDefinition } from "./types";

/**
 * How a view finds its people (piece C). Only the memory backend exists (./source.ts): it reads up
 * to 5,000 people from one group and filters them in memory (decision 34: no index until it is
 * decided again). An index backend for groups 2 and 3 of the plan, on the tracker, plugs in here
 * with the same input and answer.
 */

/** Where a run read its people from: Everyone, the smallest group every match is in, or the search box's matches. */
export type ViewStart = { kind: "everyone" } | { kind: "group"; tag: string } | { kind: "search" };

export interface ViewRun {
  /** Every match, in the view's order. */
  ids: string[];
  count: number;
  /** People in the group it started from. */
  total: number;
  /** That group holds more than 5,000 people: only the 5,000 most recently active were checked. */
  capped: boolean;
  start: ViewStart;
  /** Per filter, in order: why it is ignored or narrowed now, or null. */
  flags: Array<FilterFlag | null>;
  sortIgnored: boolean;
}

export interface ViewRunInput {
  definition: ViewDefinition;
  /** The search box: narrows the view while someone looks, never saved. */
  q?: string;
  /** The brand's People field list, archived fields included. */
  fields: readonly RecordField[];
  /** The brand's time zone for day filters; UTC when unset. */
  timeZone?: string | null;
  now?: Date;
}

export type ViewRunResult = { ok: true; run: ViewRun } | { ok: false; error: "views_busy" };

export interface ViewBackend {
  run(ctx: TenantContext, input: ViewRunInput, db?: FirestoreLike): Promise<ViewRunResult>;
}

/** The backend views use. */
export function viewBackend(): ViewBackend {
  return memoryBackend;
}

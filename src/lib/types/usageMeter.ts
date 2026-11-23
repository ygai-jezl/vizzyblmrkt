/**
 * One brand's usage of paid resources in one calendar month (`usage_meters`, src/lib/plans/meter.ts):
 * `um_<tenantId>_<YYYY-MM>`. Raw units only; anything priced from them (AI credits) is worked out
 * when read, never stored beside them.
 */

export interface ResourceCount {
  /** Units used this month (for web searches: Google searches run). */
  total: number;
  /** Calls that spent it. */
  calls: number;
  /** Calls that failed after they may have spent it, so their units couldn't be counted. */
  lostCalls: number;
  /** Units by the feature that used them (RESOURCES[...].purposes). */
  byPurpose: Record<string, number>;
}

export interface UsageMeterDoc {
  id: string;
  tenantId: string;
  /** "YYYY-MM", UTC. */
  month: string;
  meters: Record<string, ResourceCount>;
  updatedAt: string;
}

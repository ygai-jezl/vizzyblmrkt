/**
 * Daily counts kept forever, with no person in them (widget views, product events). Each day is
 * split over a few shard documents so a busy day never contends on one; readers add the shards.
 */
export interface WidgetViewDay {
  id: string;
  tenantId: string;
  campaignId: string;
  /** YYYY-MM-DD, UTC. */
  day: string;
  shard: number;
  views: number;
  updatedAt: string;
}

export interface ProductEventDay {
  id: string;
  tenantId: string;
  connectionId: string;
  day: string;
  shard: number;
  /** Accepted events by name (at most 200 names; the rest under "other"). */
  counts: Record<string, number>;
  updatedAt: string;
}

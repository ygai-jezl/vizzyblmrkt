import { getTenantById } from "@/lib/tenant/registry";
import { listPatternVersions } from "@/lib/tenant";
import type { TenantContext, FirestoreLike } from "@/lib/tenant/types";
import type { LearnedPatternRule } from "@/lib/types/tenant";
import type { LearnedPatternVersion } from "@/lib/types/learnedPatternVersion";

/**
 * Assemble the per-channel Content Steering view: the live learned directive + its DO/AVOID moves,
 * plus the version timeline (each carrying the judge rationale + evidence) that powers the
 * transparency panel and the point-in-time revert control.
 */

/**
 * Channels the Distribute loop can actually learn on — the ones with a metrics source (LinkedIn
 * company-page stats + X public metrics). Instagram publishes but has no metrics fetch, so it can't
 * be learned and is excluded here AND in reconcile's scoring loop (they must stay in sync). Order =
 * display order.
 */
export const STEERING_CHANNELS = ["linkedin", "x"] as const;
const MAX_VERSIONS = 20;

export interface ChannelSteeringState {
  channel: string;
  directive: string | null;
  perform: LearnedPatternRule[];
  avoid: LearnedPatternRule[];
  sampleCount: number;
  activeVersion: number;
  latestVersion: number;
  pinnedVersion: number | null;
  frozen: boolean;
  versions: LearnedPatternVersion[]; // newest first
}

export async function getSteeringState(
  ctx: TenantContext,
  db?: FirestoreLike,
): Promise<ChannelSteeringState[]> {
  const tenant = await getTenantById(ctx.tenantId, db);
  const fragments = tenant?.learnedPostPatterns?.channelFragments ?? {};
  const out: ChannelSteeringState[] = [];
  for (const channel of STEERING_CHANNELS) {
    const frag = fragments[channel];
    const versions = await listPatternVersions(ctx, channel, MAX_VERSIONS, db).catch(() => []);
    // Skip a channel with nothing learned yet (no fragment and no history).
    if (!frag && versions.length === 0) continue;
    out.push({
      channel,
      directive: frag?.directive ?? null,
      perform: frag?.perform ?? [],
      avoid: frag?.avoid ?? [],
      sampleCount: frag?.sampleCount ?? 0,
      activeVersion: frag?.activeVersion ?? 0,
      latestVersion: frag?.latestVersion ?? 0,
      pinnedVersion: frag?.pinnedVersion ?? null,
      frozen: frag?.frozen ?? false,
      versions,
    });
  }
  return out;
}

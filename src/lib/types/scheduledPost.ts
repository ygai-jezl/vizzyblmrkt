import { z } from "zod";

/**
 * A scheduled distribution post — the unit of work drained by the Distribute
 * worker (src/lib/distribute/scheduler.ts). Lives in the tenant-scoped
 * `campaign_scheduled_posts` collection (REGIONAL DB). It is BOTH the content
 * payload (copied from a Create ContentNode) AND the queue job: idempotent, the
 * document id IS the `dedupeKey`, so a node can never be double-scheduled.
 *
 * Mirrors the EmailJob queue shape (src/lib/types/emailJob.ts) — status +
 * `claimedAt` lease + `attempts` + `scheduledAt` eligibility — so the worker reuses
 * the same claim / retry / idempotency invariants. `publishedRef`, set ONCE at
 * publish, is the retry guard (mirrors EmailJob.emailSentAt): a retry after a
 * successful-but-unacked publish never re-posts.
 *
 * The later `jobKind`s + optional fields (spintax/thread/carousel/pps/autoPlug)
 * are declared now so the schema is stable across phases (see the Distribute
 * Roadmap): the worker only runs `publish` in Phase 1, the rest arrive with their
 * phase and don't require a migration.
 */

/** Destination channels (subset of src/lib/content/channels.ts that Distribute publishes). */
export const ScheduledPostChannel = z.enum([
  "blog",
  "newsletter",
  "linkedin",
  "x",
  "instagram",
]);
export type ScheduledPostChannel = z.infer<typeof ScheduledPostChannel>;

export const ScheduledPostStatus = z.enum([
  "pending",
  "processing",
  "done",
  "failed",
]);
export type ScheduledPostStatus = z.infer<typeof ScheduledPostStatus>;

/**
 * The unit of work. Phase 1 only ever runs `publish`; the later kinds are declared
 * now so the schema is stable across phases (the worker throws `not_implemented`
 * for them until their phase lands).
 */
export const ScheduledPostJobKind = z.enum([
  "publish", // publish the post body to its channel
  "auto_plug_comment", // Phase 4: append a promo comment once a threshold is crossed
  "auto_engage_draft", // Phase 4: draft a reply to a tracked profile's post
  "auto_dm", // Phase 4: deliver a resource DM on a comment trigger
  "performance_fetch", // Phase 3/4: fetch real engagement 48h post-publish
  "li_connection_request", // Phase 6b: LinkedIn intent orchestrator
  "li_dm_held",
  "li_dm_release",
]);
export type ScheduledPostJobKind = z.infer<typeof ScheduledPostJobKind>;

/** Where a published post landed — set ONCE at publish; the retry idempotency guard. */
export const PublishedRefSchema = z.object({
  /** "manual" until a live channel adapter (Phase 4+) posts for real. */
  platform: z.string().max(40),
  remoteId: z.string().max(200).nullable().optional(),
  url: z.string().max(2000).nullable().optional(),
  publishedAt: z.string(),
});
export type PublishedRef = z.infer<typeof PublishedRefSchema>;

/** Auto-Plug rule (defined in Phase 2; fired in Phase 4). */
export const AutoPlugSchema = z.object({
  thresholdMetric: z.enum(["likes", "comments", "reposts"]),
  thresholdValue: z.number().int().positive(),
  commentBody: z.string().max(2000),
  firedAt: z.string().nullable().optional(),
});
export type AutoPlug = z.infer<typeof AutoPlugSchema>;

const MAX_BODY_CHARS = 20000;

export const ScheduledPostSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  /** The workspace + Create plan/node this post was scheduled from (link-back). */
  workspaceId: z.string(),
  contentPlanId: z.string(),
  nodeId: z.string(),
  channel: ScheduledPostChannel,
  format: z.string().max(40).nullable().optional(),
  jobKind: ScheduledPostJobKind.default("publish"),
  status: ScheduledPostStatus,
  /** Equal to the document id; the idempotency key. */
  dedupeKey: z.string(),
  /** ISO time the post becomes eligible to publish. */
  scheduledAt: z.string(),
  attempts: z.number().int().nonnegative(),
  /** Set while status==="processing"; lets the worker reclaim stale (crashed) claims. */
  claimedAt: z.string().nullable().optional(),
  /** The copy to publish (copied from the ContentNode body at schedule time). */
  body: z.string().max(MAX_BODY_CHARS),
  /** Phase 2: raw {a|b|c} source; one variant is rendered into `renderedVariant` at publish. */
  spintaxSource: z.string().max(MAX_BODY_CHARS).nullable().optional(),
  renderedVariant: z.string().max(MAX_BODY_CHARS).nullable().optional(),
  /** Phase 2: an X thread split into ordered parts. */
  threadParts: z.array(z.string().max(2000)).max(50).nullable().optional(),
  /** Phase 2: carousel asset ids (served via the app proxy). */
  carouselAssetRefs: z.array(z.string().max(200)).max(20).nullable().optional(),
  /** Phase 6a: single on-brand post image (a workspace-asset filename, copied from the
   *  Create node's `imageAssetRef` at schedule time). The worker uploads it to LinkedIn
   *  and attaches it as the post's image. Null → text-only post. Bound ≥ the source
   *  ContentNode.imageAssetRef (max 2000) so a valid ref can never be rejected here. */
  imageAssetRef: z.string().max(2000).nullable().optional(),
  /** Phase 6a: accessibility alt text for the attached image (copied from the node's
   *  `imagePrompt`). Sent as the LinkedIn media altText; null → image ships without it. */
  imageAltText: z.string().max(1000).nullable().optional(),
  /** Phase 3: predictive performance score at schedule time. */
  pps: z
    .object({
      score: z.number().min(0).max(100),
      breakdown: z.record(z.string(), z.number()),
    })
    .nullable()
    .optional(),
  /** Phase 2/4: auto-plug rule attached to this post. */
  autoPlug: AutoPlugSchema.nullable().optional(),
  /** Phase 4: for an `auto_plug_comment` job — the parent tweet's remote id whose
   *  metrics are polled and under which the promo comment is posted. */
  sourceRemoteId: z.string().max(200).nullable().optional(),
  /** Phase 6a: for a LinkedIn post — the author to publish as. Absent/null = the
   *  connected member (personal); `urn:li:organization:{id}` = a Company Page the
   *  member administers (org posting via the CM connection). */
  linkedInAuthorUrn: z.string().max(200).nullable().optional(),
  /** Set once at publish; the retry guard (mirrors EmailJob.emailSentAt). */
  publishedRef: PublishedRefSchema.nullable().optional(),
  lastError: z.string().nullable().optional(),
  createdAt: z.string(),
  processedAt: z.string().nullable().optional(),
});
export type ScheduledPost = z.infer<typeof ScheduledPostSchema>;

export const SCHEDULED_POST_LIMITS = { MAX_BODY_CHARS } as const;

/** One scheduled post per (workspace, plan, node); rescheduling re-times the same doc. */
export function scheduledPostDedupeKey(
  workspaceId: string,
  contentPlanId: string,
  nodeId: string,
): string {
  return `post:${workspaceId}:${contentPlanId}:${nodeId}`;
}

import type { TenantContext } from "@/lib/tenant";
import type { Campaign } from "@/lib/types/campaign";
import type { JourneyStatus } from "@/lib/types/journey";

/**
 * Canvas authoring — the reusable abstraction that lets an agent build a visual
 * "canvas" (today: the email Journey Canvas; later: a second email-sequence
 * canvas) and save it as a DRAFT for human review. Each canvas KIND owns its
 * schema, Agent-3 content fill, validation, and draft persistence behind one
 * self-contained `authorDraft`, so the agent endpoint stays generic over kind.
 *
 * Adding a second canvas = one new module under kinds/ + one line in registry.ts.
 * Nothing in the endpoint, auth, or agent tool changes.
 */

export type CanvasAuthorOutcome =
  | {
      ok: true;
      journeyId: string;
      status: JourneyStatus;
      /** Soft issues (e.g. an incomplete graph) — the draft still saves so the
       *  human can finish it on the canvas; activation is independently gated. */
      warnings: string[];
    }
  | {
      ok: false;
      error: "invalid_graph" | "campaign_not_found" | "journey_active";
      /** Zod issue strings when error === "invalid_graph". */
      issues?: string[];
    };

export interface CanvasAuthorArgs {
  ctx: TenantContext;
  /** Loaded by the endpoint (kind-agnostic) so Agent 3 can match brand tone. */
  campaign: Campaign;
  campaignId: string;
  /** The graph the agent assembled; the kind validates it against its schema. */
  rawGraph: unknown;
  /** Natural-language ask, used to brief Agent 3 per node. */
  brief: string;
}

export interface CanvasKind {
  /** Stable id used in the agent request + registry (e.g. "journey"). */
  kind: string;
  /** Human label woven into the summary surfaced back through the agent. */
  label: string;
  /**
   * Parse rawGraph → fill copy via Agent 3 → validate → persist as a DRAFT.
   * Never activates. Returns a structured outcome the endpoint maps to HTTP.
   */
  authorDraft(args: CanvasAuthorArgs): Promise<CanvasAuthorOutcome>;
}

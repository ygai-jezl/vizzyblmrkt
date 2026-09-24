import type { TenantContext } from "@/lib/tenant";

/**
 * Canvas authoring — the reusable abstraction that lets an agent build a visual
 * "canvas" and save it as a DRAFT for human review. Kinds:
 *  - `journey`: a launch's email Journey Canvas (scope: a campaign);
 *  - `lifecycle`: a connected product's lifecycle journey (scope: a product
 *    connection, and optionally the journey being edited);
 *  - `content_plan`: a content programme's plan (scope: a programme, and
 *    optionally the plan being edited) — nav v2 phase 4;
 *  - `invite_wave`: an invite of a launch's waitlist into the product (scope: a
 *    launch, and optionally the draft wave) — nav v2 phase 4.
 * Each kind owns its request shape, scope loading, content fill, validation,
 * persistence and the words it says back, behind one `authorDraft`, so the
 * agent endpoint stays generic.
 *
 * Adding a canvas = one new module under kinds/ + one line in registry.ts.
 */

/** Where a draft lives. The kind resolves it from the request (never trusts tenant ids in it). */
export type CanvasScope =
  | { kind: "journey"; campaignId: string }
  | { kind: "lifecycle"; connectionId: string; journeyId?: string | null }
  | { kind: "content_plan"; workspaceId: string; planId?: string | null }
  | { kind: "invite_wave"; campaignId: string; waveId?: string | null };

/** What the chat shows for a saved draft (a card with an "Open canvas" link). */
export interface CanvasCard {
  kind: string;
  id: string;
  title: string;
  subtitle?: string;
  url: string;
  stats: Array<{ label: string; value: string | number }>;
  warnings: number;
}

export type CanvasAuthorOutcome =
  | {
      ok: true;
      id: string;
      status: string;
      /** Admin path of the canvas that now holds the draft. */
      url: string;
      /** Written for the operator — the agent relays it. */
      summary: string;
      /** Soft issues: the draft still saved, for the human to finish. */
      warnings: string[];
      card: CanvasCard;
    }
  | {
      ok: false;
      /** HTTP status for the endpoint to return. */
      status: number;
      error: string;
      /** Structured problems the agent can repair and retry. */
      issues?: unknown[];
    };

export interface CanvasAuthorArgs {
  /** Reconstructed from the signed capability token — the ONLY source of tenant scope. */
  ctx: TenantContext;
  /** The request body; each kind parses what it needs from it. */
  input: Record<string, unknown>;
  /** Natural-language ask from the operator. */
  brief: string;
}

export interface CanvasKind {
  /** Stable id used in the agent request + registry (e.g. "journey"). */
  kind: string;
  /** Human label, e.g. "email journey". */
  label: string;
  /** Parse → load scope → build/fill → validate → persist as a DRAFT. Never activates or publishes. */
  authorDraft(args: CanvasAuthorArgs): Promise<CanvasAuthorOutcome>;
}

import type { TenantContext } from "@/lib/tenant";
import type { Made } from "@/lib/types/loopStamp";
import type { CanvasKindName } from "./names";

/**
 * Canvas authoring — the reusable abstraction that lets an agent build a visual
 * "canvas" and save it as a DRAFT for human review. Kinds:
 *  - `journey`: a launch's email Journey Canvas (scope: a campaign);
 *  - `lifecycle`: a connected product's lifecycle journey (scope: a product
 *    connection, and optionally the journey being edited);
 *  - `content_plan`: a content programme's plan (scope: a programme, and
 *    optionally the plan being edited) — nav v2 phase 4;
 *  - `invite_wave`: an invite of a launch's waitlist into the product (scope: a
 *    launch, and optionally the draft wave) — nav v2 phase 4;
 *  - `email_style`: a suggested Email style (scope: the whole brand) that an
 *    admin reviews and saves on Brand › Email style;
 *  - `journey_style`: one lifecycle journey's own Email style, in its draft
 *    (scope: the journey, or a launch's welcome journey);
 *  - `person_plan`: a plan for one product user (scope: the person, by our id
 *    for them), which staff approve on the person's page;
 *  - `brand_map`: suggestions for the brand map (scope: the whole brand), which an
 *    admin accepts or dismisses on Brand › Brand map;
 *  - `image_style`: a suggested image style (scope: the whole brand) that an admin
 *    reviews and saves on Brand › Image style;
 *  - `person_fields`: suggested changes to one person's fields (scope: the person, by
 *    our `ct_` id for them), which an admin confirms on their page or from Review;
 *  - `new_person`: the New person form filled in from the chat (scope: the whole brand),
 *    which an admin opens, checks and confirms, recording consent themselves.
 * Each kind owns its request shape, scope loading, content fill, validation,
 * persistence and the words it says back, behind one `authorDraft`, so the
 * agent endpoint stays generic.
 *
 * Adding a canvas = its name in names.ts, one new module under kinds/ and one line in
 * registry.ts, then its line in src/lib/loops/registry.ts (typecheck asks for each).
 */

/** Where a draft lives. The kind resolves it from the request (never trusts tenant ids in it). */
export type CanvasScope =
  | { kind: "journey"; campaignId: string }
  | { kind: "lifecycle"; connectionId: string; journeyId?: string | null }
  | { kind: "content_plan"; workspaceId: string; planId?: string | null }
  | { kind: "invite_wave"; campaignId: string; waveId?: string | null }
  | { kind: "email_style" }
  | { kind: "journey_style"; journeyId: string }
  | { kind: "person_plan"; personId: string }
  | { kind: "brand_map" }
  | { kind: "image_style" }
  | { kind: "person_fields"; personId: string }
  | { kind: "new_person" };

/** What the chat shows for a saved draft (a card with an "Open canvas" link). */
export interface CanvasCard {
  kind: string;
  id: string;
  title: string;
  subtitle?: string;
  url: string;
  stats: Array<{ label: string; value: string | number }>;
  warnings: number;
  /** The line under the stats, when the draft note doesn't fit (e.g. a suggestion). */
  note?: string;
  /** The link's label, instead of "Open canvas". */
  cta?: string;
}

/** What one canvas save wrote: a new draft, new words on one already counted, or nothing new. */
export type CanvasSaved = "created" | "rewritten" | "none";

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
      /**
       * What the call saved (learning loops step 5, decision 20: made counts once per saved
       * record): `created`, a new draft or suggestion; `rewritten`, Vizzy's new words on a draft
       * already counted (an invite wave, a plan's pieces, a journey's draft); `none`, nothing new
       * (the person is already in People, or the same draft is already waiting), or nothing of
       * the kind's own (a content plan, whose pieces count under their writers' kinds). The route
       * counts made only for `created`.
       */
      saved: CanvasSaved;
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
  /**
   * What made the draft (learning loops step 5, 4.1): the route's `canvas.<kind>` stamp from
   * learnedFor, `by: "vizzy"`, or `{ unstamped: "loops_off" }` with LOOPS_ENABLED off. Each kind
   * keeps it on the draft it writes where that record has a `made` (keptMade), and the route
   * counts it made once a new draft is saved (`saved: "created"`).
   */
  made: Made;
}

export interface CanvasKind<K extends CanvasKindName = CanvasKindName> {
  /** Stable id used in the agent request + registry (e.g. "journey"), one of CANVAS_KIND_NAMES. */
  kind: K;
  /** Human label, e.g. "email journey". */
  label: string;
  /** Parse → load scope → build/fill → validate → persist as a DRAFT. Never activates or publishes. */
  authorDraft(args: CanvasAuthorArgs): Promise<CanvasAuthorOutcome>;
}

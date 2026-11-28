import type { CanvasKind } from "./types";
import { CANVAS_KIND_NAMES, isCanvasKindName, type CanvasKindName } from "./names";
import { journeyCanvasKind } from "./kinds/journey";
import { lifecycleCanvasKind } from "./kinds/lifecycle";
import { inviteWaveCanvasKind } from "./kinds/inviteWave";
import { contentPlanCanvasKind } from "./kinds/contentPlan";
import { emailStyleCanvasKind } from "./kinds/emailStyle";
import { journeyStyleCanvasKind } from "./kinds/journeyStyle";
import { personPlanCanvasKind } from "./kinds/personPlan";
import { brandMapCanvasKind } from "./kinds/brandMap";
import { imageStyleCanvasKind } from "./kinds/imageStyle";
import { personFieldsCanvasKind } from "./kinds/personFields";
import { newPersonCanvasKind } from "./kinds/newPerson";
import { raiseDeckCanvasKind } from "./kinds/raiseDeck";

/**
 * The registry of agent-authorable canvas kinds. To add another canvas: put its name in
 * names.ts, implement its module under kinds/ and add one line here. The agent endpoint and
 * capability-token auth are kind-agnostic. Literal keys (never computed ones) let `satisfies`
 * check that every name has a module, every module a name, and each key matches its module's kind.
 */
const KINDS = {
  journey: journeyCanvasKind,
  lifecycle: lifecycleCanvasKind,
  invite_wave: inviteWaveCanvasKind,
  content_plan: contentPlanCanvasKind,
  email_style: emailStyleCanvasKind,
  journey_style: journeyStyleCanvasKind,
  person_plan: personPlanCanvasKind,
  brand_map: brandMapCanvasKind,
  image_style: imageStyleCanvasKind,
  person_fields: personFieldsCanvasKind,
  new_person: newPersonCanvasKind,
  raise_deck: raiseDeckCanvasKind,
} as const satisfies { readonly [K in CanvasKindName]: CanvasKind<K> };

export function getCanvasKind(kind: string): CanvasKind | null {
  return isCanvasKindName(kind) ? KINDS[kind] : null;
}

export function canvasKindNames(): string[] {
  return [...CANVAS_KIND_NAMES];
}

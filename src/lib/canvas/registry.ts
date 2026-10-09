import type { CanvasKind } from "./types";
import { journeyCanvasKind } from "./kinds/journey";
import { lifecycleCanvasKind } from "./kinds/lifecycle";
import { inviteWaveCanvasKind } from "./kinds/inviteWave";
import { contentPlanCanvasKind } from "./kinds/contentPlan";
import { emailStyleCanvasKind } from "./kinds/emailStyle";
import { journeyStyleCanvasKind } from "./kinds/journeyStyle";
import { personPlanCanvasKind } from "./kinds/personPlan";

/**
 * The registry of agent-authorable canvas kinds. To add another canvas:
 * implement its module under kinds/ and add one line here — the agent endpoint
 * and capability-token auth are kind-agnostic.
 */
const KINDS: Record<string, CanvasKind> = {
  [journeyCanvasKind.kind]: journeyCanvasKind,
  [lifecycleCanvasKind.kind]: lifecycleCanvasKind,
  [inviteWaveCanvasKind.kind]: inviteWaveCanvasKind,
  [contentPlanCanvasKind.kind]: contentPlanCanvasKind,
  [emailStyleCanvasKind.kind]: emailStyleCanvasKind,
  [journeyStyleCanvasKind.kind]: journeyStyleCanvasKind,
  [personPlanCanvasKind.kind]: personPlanCanvasKind,
};

export function getCanvasKind(kind: string): CanvasKind | null {
  return KINDS[kind] ?? null;
}

export function canvasKindNames(): string[] {
  return Object.keys(KINDS);
}

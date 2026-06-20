import type { CanvasKind } from "./types";
import { journeyCanvasKind } from "./kinds/journey";

/**
 * The registry of agent-authorable canvas kinds. To add a second email-sequence
 * canvas: implement its module under kinds/ and add one line here — the agent
 * endpoint, capability-token auth, and ADK tool are all kind-agnostic.
 */
const KINDS: Record<string, CanvasKind> = {
  [journeyCanvasKind.kind]: journeyCanvasKind,
};

export function getCanvasKind(kind: string): CanvasKind | null {
  return KINDS[kind] ?? null;
}

export function canvasKindNames(): string[] {
  return Object.keys(KINDS);
}

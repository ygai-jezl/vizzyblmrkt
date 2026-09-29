"use client";

import { useEffect, useState } from "react";
import type { StepMove, StepPlacementReport } from "@/lib/connect/stepPlacement";
import { api, type PublicConnection } from "./api";
import { Button } from "./ui";

/**
 * Onboarding steps the product sends somewhere other than where the catalog
 * counts them — per brand when the catalog says per person, or the other way
 * round. Until they match, those steps never count: progress stays at 0 and
 * nobody is activated. On the Catalog tab each comes with the fix (applied to the
 * unsaved edits); elsewhere it points there.
 */
export function StepPlacementNotice({
  connection,
  draftSteps,
  onFix,
  onOpenCatalog,
}: {
  connection: PublicConnection;
  /** On the Catalog tab: the steps being edited, so a move already made there stops showing. */
  draftSteps?: Array<{ id: string; kind?: string | null }>;
  onFix?: (move: StepMove) => void;
  onOpenCatalog?: () => void;
}) {
  const [report, setReport] = useState<StepPlacementReport | null>(null);

  // Re-read when the saved catalog changes: a save that fixes it clears the notice.
  useEffect(() => {
    let live = true;
    void api<StepPlacementReport>(`/api/admin/connections/${connection.id}/step-placement`).then((r) => {
      if (live && r.ok) setReport(r.data);
    });
    return () => {
      live = false;
    };
  }, [connection.id, connection.catalogRev]);

  if (!report) return null;
  const kinds = connection.catalog.entityKinds ?? [];
  const label = (id: string) => connection.catalog.onboardingSteps.find((s) => s.id === id)?.label || id;
  const where = (p: string | null) => (p === null ? "per person" : `per ${kinds.find((k) => k.kind === p)?.label ?? p}`);
  const kindOf = (id: string) => draftSteps?.find((s) => s.id === id)?.kind ?? null;
  const moves = report.moves.filter((m) => !draftSteps || m.stepIds.some((id) => kindOf(id) !== m.to));
  const unknown = draftSteps ? report.unknown.filter((u) => !draftSteps.some((s) => s.id === u.id)) : [];
  if (moves.length === 0 && unknown.length === 0) return null;

  return (
    <div role="status" className="space-y-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
      {moves.map((m) => {
        const n = m.stepIds.length;
        return (
          <div key={`${m.from}-${m.to}`} className="space-y-1.5">
            <p>
              <span className="font-medium">
                Your server sends {n === 1 ? "a step" : `${n} steps`} {where(m.to)}, but the catalog counts {n === 1 ? "it" : "them"} {where(m.from)}
              </span>{" "}
              — {m.stepIds.map(label).join(", ")}. Until they match, {n === 1 ? "it doesn't" : "they don't"} count towards anyone&apos;s onboarding
              progress or activation. Seen for {m.users} {m.users === 1 ? "user" : "users"}.
            </p>
            {m.unknownKind ? (
              <p>
                The catalog doesn&apos;t name <code className="font-mono">{m.to}</code> yet: add it under &ldquo;Things people have several of&rdquo; first.
              </p>
            ) : onFix ? (
              <Button tone="primary" onClick={() => onFix(m)}>
                Count {n === 1 ? "it" : "them"} {where(m.to)}
              </Button>
            ) : onOpenCatalog ? (
              <Button onClick={onOpenCatalog}>Fix it in the Catalog</Button>
            ) : null}
          </div>
        );
      })}
      {unknown.length > 0 ? (
        <p>
          Also sent, but not in the catalog:{" "}
          {unknown.map((u, i) => (
            <span key={`${u.id}-${u.placement}`}>
              {i ? ", " : ""}
              <code className="font-mono">{u.id}</code> ({where(u.placement)})
            </span>
          ))}
          . Add them as steps, with &ldquo;Done per&rdquo; set to match, for them to count.
        </p>
      ) : null}
    </div>
  );
}

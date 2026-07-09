"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CreateWizard } from "./CreateWizard";
import { isEbookUiEnabled } from "@/lib/content/create/ebook";
import type { IngestionTicket } from "@/lib/types/ingestionTicket";
import type { ContentPlan } from "@/lib/types/contentPlan";

/**
 * Create pillar landing — lists the workspace's saved content workflows and hosts
 * the intake wizard for new ones. Each plan links to its canvas. After the wizard
 * builds a plan (Architect), we route straight to the canvas to watch it fill.
 */
const STATUS_STYLE: Record<string, string> = {
  draft: "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  generating: "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300",
  ready: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  scheduled: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300",
  archived: "bg-neutral-100 text-neutral-500 dark:bg-neutral-900 dark:text-neutral-500",
};

export function CreatePanel({
  workspaceId,
  initialPlans,
  topics,
  initialSources,
}: {
  workspaceId: string;
  initialPlans: ContentPlan[];
  topics: string[];
  initialSources: IngestionTicket[];
}) {
  const router = useRouter();
  const [plans] = useState<ContentPlan[]>(initialPlans);
  const [showWizard, setShowWizard] = useState(initialPlans.length === 0);

  function onCreated(plan: ContentPlan) {
    // eBook plans open the authoring studio first; everything else goes straight to the
    // canvas (the wizard already ran the Architect for those).
    const dest =
      plan.topology.hubChannel === "ebook"
        ? `/admin/workspace/${workspaceId}/create/${plan.id}/ebook`
        : `/admin/workspace/${workspaceId}/create/${plan.id}`;
    router.push(dest);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Create</h2>
          <p className="text-sm text-neutral-500">
            Describe your goal — an agent builds a hub-and-spoke content workflow on a canvas,
            grounded in your knowledge base.
          </p>
        </div>
        {!showWizard ? (
          <button
            type="button"
            onClick={() => setShowWizard(true)}
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900"
          >
            + New workflow
          </button>
        ) : null}
      </div>

      {showWizard ? (
        <CreateWizard
          workspaceId={workspaceId}
          topics={topics}
          initialSources={initialSources}
          onCreated={onCreated}
          onCancel={() => setShowWizard(false)}
        />
      ) : null}

      {plans.length > 0 ? (
        <ul className="divide-y divide-neutral-200 rounded-md border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {plans.map((p) => {
            const nodes = p.graph.nodes.length;
            const done = p.graph.nodes.filter(
              (n) => n.status === "generated" || n.status === "approved",
            ).length;
            // An eBook that hasn't been finalized (no graph yet) resumes in the STUDIO, not the
            // empty canvas — otherwise there's no way back into the authoring surface. Guarded by
            // the flag so a flag-off rollback falls back to the canvas (which degrades gracefully)
            // instead of a studio-route 404.
            const isEbookDraft = isEbookUiEnabled() && p.topology.hubChannel === "ebook" && nodes === 0;
            const href = isEbookDraft
              ? `/admin/workspace/${workspaceId}/create/${p.id}/ebook`
              : `/admin/workspace/${workspaceId}/create/${p.id}`;
            return (
              <li key={p.id}>
                <Link
                  href={href}
                  className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-neutral-50 dark:hover:bg-neutral-900"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">{p.name}</div>
                    <div className="text-xs text-neutral-500">
                      {isEbookDraft ? (
                        <>📖 eBook · {p.ebookDraft?.chapters.length ?? 0} chapters · resume in studio</>
                      ) : (
                        <>
                          {p.topology.hubChannel} hub · {p.topology.spokeChannels.length} spoke
                          {p.topology.spokeChannels.length === 1 ? "" : "s"}
                          {nodes ? ` · ${done}/${nodes} generated` : " · not built yet"}
                        </>
                      )}
                    </div>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                      STATUS_STYLE[p.status] ?? STATUS_STYLE.draft
                    }`}
                  >
                    {p.status}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : !showWizard ? (
        <p className="rounded-md border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
          No workflows yet. Create one to get started.
        </p>
      ) : null}
    </div>
  );
}

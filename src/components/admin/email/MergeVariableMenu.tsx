"use client";

import { MERGE_VARS } from "@/lib/email/mergeVars";

/**
 * Inserts {{merge_vars}} into the email body at the cursor. Variables render
 * per-recipient for journeys (incl. {{current_rank}}) and as MailChimp merge
 * tags for broadcasts (see lib/agents/compiler.ts).
 */
export function MergeVariableMenu({
  onInsert,
}: {
  onInsert: (token: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="mr-1 text-xs text-neutral-400">Insert:</span>
      {MERGE_VARS.map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onInsert(`{{${v}}}`)}
          className="rounded border border-neutral-300 px-1.5 py-0.5 font-mono text-xs text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
        >
          {`{{${v}}}`}
        </button>
      ))}
    </div>
  );
}

"use client";

import type { ContactEmailHistoryEntry } from "@/lib/crm/emailHistory";

const BADGE: Record<ContactEmailHistoryEntry["status"], string> = {
  sent: "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  opened: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  clicked: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  bounced: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
};

export function EmailHistoryList({ emails }: { emails: ContactEmailHistoryEntry[] }) {
  if (emails.length === 0) {
    return <p className="text-xs text-neutral-400">No emails sent yet.</p>;
  }
  return (
    <ul className="divide-y divide-neutral-100 overflow-hidden rounded-md border border-neutral-200 dark:divide-neutral-900 dark:border-neutral-800">
      {emails.map((e) => (
        <li key={`${e.journeyId}:${e.nodeId}:${e.signupId}:${e.variantId}`} className="flex items-center gap-3 px-3 py-2 text-sm">
          <span className="min-w-0 flex-1 truncate">{e.subject || "(no subject)"}</span>
          <span className="tabular-nums text-xs text-neutral-400">{(e.sentAt ?? "").slice(0, 10) || "—"}</span>
          {e.opened ? (
            <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-800 dark:bg-blue-900/40 dark:text-blue-300">opened</span>
          ) : null}
          {e.clicked ? (
            <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-800 dark:bg-green-900/40 dark:text-green-300">clicked</span>
          ) : null}
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${BADGE[e.status]}`}>{e.status}</span>
        </li>
      ))}
    </ul>
  );
}

"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import type { EditTaskBody } from "@/lib/work/inputs";
import { workCall, workErrorText } from "./api";

/**
 * A change to one task from its page: PATCH /api/admin/work/tasks/[ref] with the task's updatedAt
 * as the page shows it (so a change made since, in another tab or by someone else, is refused, not
 * undone), then the page reads the task again. What Work did besides what was asked (the check Done
 * set) comes back as a notice, cleared when the next change starts.
 */
export function useTaskPatch(task: { ref: number; updatedAt: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { ref, updatedAt } = task;
  const patch = useCallback(
    async (body: Omit<EditTaskBody, "via" | "baseUpdatedAt">): Promise<boolean> => {
      setBusy(true);
      setError(null);
      setNotice(null);
      const r = await workCall<{ notice: string | null }>(`/tasks/${ref}`, "PATCH", { ...body, via: "work_page", baseUpdatedAt: updatedAt });
      setBusy(false);
      if (!r.ok) {
        setError(workErrorText(r.data));
        return false;
      }
      setNotice(r.data.notice ?? null);
      router.refresh();
      return true;
    },
    [ref, updatedAt, router],
  );
  const clearNotice = useCallback(() => setNotice(null), []);
  return { patch, busy, error, notice, setError, clearNotice };
}

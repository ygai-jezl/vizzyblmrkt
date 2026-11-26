"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import type { EditTaskBody } from "@/lib/work/inputs";
import { workCall, workErrorText } from "./api";

/**
 * A change to one task from its page: PATCH /api/admin/work/tasks/[ref], then the page reads the
 * task again. What Work did besides what was asked (the check Done set) comes back as a notice.
 */
export function useTaskPatch(ref: number) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const patch = useCallback(
    async (body: Omit<EditTaskBody, "via">): Promise<boolean> => {
      setBusy(true);
      setError(null);
      const r = await workCall<{ notice: string | null }>(`/tasks/${ref}`, "PATCH", { ...body, via: "work_page" });
      setBusy(false);
      if (!r.ok) {
        setError(workErrorText(r.data));
        return false;
      }
      setNotice(r.data.notice ?? null);
      router.refresh();
      return true;
    },
    [ref, router],
  );
  return { patch, busy, error, notice, setError };
}

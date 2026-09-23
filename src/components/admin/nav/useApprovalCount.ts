"use client";

import { useEffect, useState } from "react";
import { isLifecycleUiEnabled } from "@/lib/lifecycle/flags";
import { isNavV2Phase2Enabled } from "@/lib/nav/flags";

/** A count polled every minute while the admin is open; 0 when there's no endpoint. */
function usePolledCount(endpoint: string | null): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!endpoint) return;
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(endpoint);
        if (!res.ok) return;
        const data = (await res.json()) as { count?: number };
        if (alive && typeof data.count === "number") setCount(data.count);
      } catch {
        // Offline or signed out — keep the last count.
      }
    };
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [endpoint]);
  return count;
}

/** How many AI lines are waiting for approval (lifecycle journeys); 0 when lifecycle is off. */
export function useApprovalCount(): number {
  return usePolledCount(isLifecycleUiEnabled() ? "/api/admin/approvals/count" : null);
}

/** The Review badge: every waiting decision with nav v2 phase 2, else just the AI lines. */
export function useReviewCount(): number {
  return usePolledCount(
    isNavV2Phase2Enabled() ? "/api/admin/review/count" : isLifecycleUiEnabled() ? "/api/admin/approvals/count" : null,
  );
}

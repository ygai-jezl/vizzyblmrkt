"use client";

import { useEffect, useState } from "react";
import { isLifecycleUiEnabled } from "@/lib/lifecycle/flags";

/**
 * How many AI lines are waiting for approval (lifecycle journeys). Polled while
 * the admin is open; always 0 when lifecycle is off.
 */
export function useApprovalCount(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!isLifecycleUiEnabled()) return;
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/admin/approvals/count");
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
  }, []);
  return count;
}

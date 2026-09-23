"use client";

import { Star } from "lucide-react";
import { togglePin } from "@/lib/nav/model";
import { usePinnedLaunchIds } from "./pins";

/** Star a launch into (or out of) the sidebar's Pinned section. */
export function PinButton({
  tenantId,
  launchId,
  launchName,
  defaultIds,
}: {
  tenantId: string;
  launchId: string;
  launchName: string;
  /** What the sidebar shows before the user customises (see defaultPinIds). */
  defaultIds: string[];
}) {
  const [stored, save] = usePinnedLaunchIds(tenantId);
  const shown = stored ?? defaultIds;
  const pinned = shown.includes(launchId);
  return (
    <button
      type="button"
      onClick={() => save(togglePin(shown, launchId))}
      aria-pressed={pinned}
      aria-label={pinned ? `Unpin ${launchName} from the sidebar` : `Pin ${launchName} to the sidebar`}
      title={pinned ? "Unpin from sidebar" : "Pin to sidebar"}
      className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
    >
      <Star size={16} aria-hidden className={pinned ? "fill-amber-400 text-amber-500" : ""} />
    </button>
  );
}

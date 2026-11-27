import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { isWorkEnabled } from "@/lib/work/flags";
import { addScreen, screenScope, suggestionScreen } from "@/lib/work/screens";
import { isAgentActionId } from "@/lib/types/agentAction";
import { WORK_MESSAGES } from "@/lib/work/words";
import { TaskForm } from "@/components/admin/work/TaskForm";
import { WorkNote, WorkUnavailable } from "@/components/admin/work/WorkTabs";

export const dynamic = "force-dynamic";

/** Where Edit then add's Cancel goes: Review's Tasks Vizzy suggests. */
const REVIEW_SUGGESTIONS = "/admin/approvals#work_suggestion";

/**
 * The add page (WORK_ENABLED): the full form for one task, with Connected to and How we'll know it
 * worked. The origin is the person who adds it, set by the server. With `?suggestion=aa_…` it is
 * Edit then add from Review: filled with Vizzy's suggestion, its kind marked Vizzy suggests, and
 * Cancel back to Review; adding writes the task and the suggestion's result together.
 */
export default async function NewWorkTaskPage({ searchParams }: { searchParams: Promise<{ suggestion?: string | string[] }> }) {
  if (!isWorkEnabled()) notFound();
  const ctx = await requireAdminContext();
  const gate = await screenScope(ctx);
  if (!gate.ok) return <WorkUnavailable message={gate.message} />;
  const sp = await searchParams;
  const id = typeof sp.suggestion === "string" ? sp.suggestion : null;
  if (id !== null) {
    const r = isAgentActionId(id) ? await suggestionScreen(gate.scope, id) : { ok: false as const, message: WORK_MESSAGES.suggestion_missing };
    if (!r.ok) {
      return (
        <div className="mx-auto max-w-3xl space-y-4">
          <h1 className="text-xl font-semibold">Add a task</h1>
          <WorkNote tone="warn">
            {r.message}{" "}
            <Link href={REVIEW_SUGGESTIONS} className="font-medium underline underline-offset-4">
              Open Review
            </Link>
          </WorkNote>
        </div>
      );
    }
    return (
      <div className="mx-auto max-w-6xl">
        <TaskForm screen={r.screen} suggestion={r.screen.suggestion} cancelHref={REVIEW_SUGGESTIONS} />
      </div>
    );
  }
  const screen = await addScreen(gate.scope);
  return (
    <div className="mx-auto max-w-6xl">
      <TaskForm screen={screen} />
    </div>
  );
}

import { notFound } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { isWorkEnabled } from "@/lib/work/flags";
import { refParam } from "@/lib/work/http";
import { screenScope, taskScreen } from "@/lib/work/screens";
import { TaskPage } from "@/components/admin/work/TaskPage";
import { WorkUnavailable } from "@/components/admin/work/WorkTabs";

export const dynamic = "force-dynamic";

/**
 * One task (WORK_ENABLED), by its ref: its page, with All tasks back to the list. A task the person
 * can't see is not found, the same as one that isn't there. `?decision=aa_…` opens a decision Vizzy
 * drafted in chat, for the person to choose on.
 */
export default async function WorkTaskPage({ params, searchParams }: { params: Promise<{ ref: string }>; searchParams?: Promise<{ decision?: string | string[] }> }) {
  if (!isWorkEnabled()) notFound();
  const ctx = await requireAdminContext();
  const ref = refParam((await params).ref);
  if (ref === null) notFound();
  const gate = await screenScope(ctx);
  if (!gate.ok) return <WorkUnavailable message={gate.message} />;
  const sp = (await searchParams) ?? {};
  // A decision Vizzy drafted in chat: the card opens the task with it.
  const screen = await taskScreen(gate.scope, ref, {}, { decisionDraft: typeof sp.decision === "string" ? sp.decision : null });
  if (!screen) notFound();
  return (
    <div className="mx-auto max-w-6xl">
      <TaskPage screen={screen} />
    </div>
  );
}

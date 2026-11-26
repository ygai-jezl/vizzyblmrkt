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
 * can't see is not found, the same as one that isn't there.
 */
export default async function WorkTaskPage({ params }: { params: Promise<{ ref: string }> }) {
  if (!isWorkEnabled()) notFound();
  const ctx = await requireAdminContext();
  const ref = refParam((await params).ref);
  if (ref === null) notFound();
  const gate = await screenScope(ctx);
  if (!gate.ok) return <WorkUnavailable message={gate.message} />;
  const screen = await taskScreen(gate.scope, ref);
  if (!screen) notFound();
  return (
    <div className="mx-auto max-w-6xl">
      <TaskPage screen={screen} />
    </div>
  );
}

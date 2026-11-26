import { notFound } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { isWorkEnabled } from "@/lib/work/flags";
import { addScreen, screenScope } from "@/lib/work/screens";
import { TaskForm } from "@/components/admin/work/TaskForm";
import { WorkUnavailable } from "@/components/admin/work/WorkTabs";

export const dynamic = "force-dynamic";

/**
 * The add page (WORK_ENABLED): the full form for one task, with Connected to and How we'll know it
 * worked. The origin is the person who adds it, set by the server.
 */
export default async function NewWorkTaskPage() {
  if (!isWorkEnabled()) notFound();
  const ctx = await requireAdminContext();
  const gate = await screenScope(ctx);
  if (!gate.ok) return <WorkUnavailable message={gate.message} />;
  const screen = await addScreen(gate.scope);
  return (
    <div className="mx-auto max-w-6xl">
      <TaskForm screen={screen} />
    </div>
  );
}

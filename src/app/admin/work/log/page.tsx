import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { isWorkEnabled } from "@/lib/work/flags";
import { logScreen, screenScope } from "@/lib/work/screens";
import { workNameOf } from "@/lib/work/scope";
import { logSubLine } from "@/lib/work/screenWords";
import { WorkLog } from "@/components/admin/work/WorkLog";
import { WorkHeader, WorkNote, WorkTabs, WorkUnavailable } from "@/components/admin/work/WorkTabs";

export const dynamic = "force-dynamic";

/**
 * Work's Log tab (WORK_ENABLED). It opens on Today; `?day=YYYY-MM-DD` opens a past day, read only.
 * `?draft=aa_…` opens Today with a note Vizzy drafted in chat in the Log box, to save. Days are the
 * session brand's own days.
 */
export default async function WorkLogPage({ searchParams }: { searchParams: Promise<{ day?: string | string[]; draft?: string | string[] }> }) {
  if (!isWorkEnabled()) notFound();
  const ctx = await requireAdminContext();
  const gate = await screenScope(ctx);
  if (!gate.ok) return <WorkUnavailable message={gate.message} />;
  const sp = await searchParams;
  const day = typeof sp.day === "string" ? sp.day : null;
  const r = await logScreen(gate.scope, day, {}, { draft: typeof sp.draft === "string" ? sp.draft : null });
  const name = workNameOf(gate.scope);
  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <WorkHeader sub={logSubLine(name)} />
      <WorkTabs active="log" openCount={r.ok ? r.screen.openCount : null} />
      {r.ok ? (
        <WorkLog screen={r.screen} />
      ) : (
        <WorkNote tone="warn">
          {r.message}{" "}
          <Link href="/admin/work/log" className="font-medium underline underline-offset-4">
            Open today
          </Link>
        </WorkNote>
      )}
    </div>
  );
}

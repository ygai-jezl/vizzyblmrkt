import { NewLaunchForm } from "@/components/admin/NewLaunchForm";
import { requireAdminContext } from "@/lib/auth/session";
import { isIdeasEnabled, isIdeaWordsEnabled } from "@/lib/ideas/flags";
import { isWorkEnabled } from "@/lib/work/flags";

/** The page's ?name= and ?task=: Work's Make it an idea fills the name and links the task once it exists. */
function fromWork(sp: { name?: string | string[]; task?: string | string[] }): { name: string; ref: number | null } {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const ref = one(sp.task);
  return { name: one(sp.name).replace(/\s+/g, " ").trim().slice(0, 200), ref: /^\d{1,6}$/.test(ref) && Number(ref) >= 1 ? Number(ref) : null };
}

export const dynamic = "force-dynamic";

/**
 * New launch. Any member can create one; with LAUNCH_IDEAS_ENABLED an admin can also give it a
 * hypothesis here (setting an idea is for admins only, so a member's create never half fails).
 * With the words on (isIdeaWordsEnabled()) it is New idea; the form reads the words itself.
 * Work's Make it an idea opens it as ?name=<the task's title>&task=<its ref>: the name is filled in
 * and, while WORK_ENABLED, the task is linked to the idea once it is made (in this brand).
 */
export default async function NewLaunchPage({ searchParams }: { searchParams?: Promise<{ name?: string | string[]; task?: string | string[] }> }) {
  const ctx = await requireAdminContext();
  const work = fromWork((await searchParams) ?? {});
  const words = isIdeaWordsEnabled();
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="space-y-1">
        <p className="text-xs uppercase tracking-wide text-neutral-400">{words ? "Ideas" : "Active Launches"}</p>
        <h1 className="text-xl font-semibold">{words ? "New idea" : "New Launch"}</h1>
        <p className="text-sm text-neutral-500">
          {words
            ? "Start a waitlist to test an idea. Set the essentials here. The emails, people and branding live in the idea's tabs once it exists."
            : "Spin up a new waitlist for this launch. Set the essentials here. The full journey, audience, and branding live in the launch's tabs once it exists."}
        </p>
      </div>
      <NewLaunchForm
        hypothesis={isIdeasEnabled() && ctx.role === "admin"}
        initialName={work.name}
        workTask={isWorkEnabled() && work.ref !== null ? { ref: work.ref, brandId: ctx.tenantId } : null}
      />
    </div>
  );
}

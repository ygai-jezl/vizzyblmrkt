import { NewLaunchForm } from "@/components/admin/NewLaunchForm";
import { requireAdminContext } from "@/lib/auth/session";
import { isIdeasEnabled, isIdeaWordsEnabled } from "@/lib/ideas/flags";

export const dynamic = "force-dynamic";

/**
 * New launch. Any member can create one; with LAUNCH_IDEAS_ENABLED an admin can also give it a
 * hypothesis here (setting an idea is for admins only, so a member's create never half fails).
 * With the words on (isIdeaWordsEnabled()) it is New idea; the form reads the words itself.
 */
export default async function NewLaunchPage() {
  const ctx = await requireAdminContext();
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
      <NewLaunchForm hypothesis={isIdeasEnabled() && ctx.role === "admin"} />
    </div>
  );
}

import { NewLaunchForm } from "@/components/admin/NewLaunchForm";
import { requireAdminContext } from "@/lib/auth/session";
import { isIdeasEnabled } from "@/lib/ideas/flags";

export const dynamic = "force-dynamic";

/**
 * New launch. Any member can create one; with LAUNCH_IDEAS_ENABLED an admin can also give it a
 * hypothesis here (setting an idea is for admins only, so a member's create never half fails).
 */
export default async function NewLaunchPage() {
  const ctx = await requireAdminContext();
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="space-y-1">
        <p className="text-xs uppercase tracking-wide text-neutral-400">Active Launches</p>
        <h1 className="text-xl font-semibold">New Launch</h1>
        <p className="text-sm text-neutral-500">
          Spin up a new waitlist for this launch. Set the essentials here. The full journey, audience, and branding live in
          the launch&apos;s tabs once it exists.
        </p>
      </div>
      <NewLaunchForm hypothesis={isIdeasEnabled() && ctx.role === "admin"} />
    </div>
  );
}

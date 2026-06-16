import { NewLaunchForm } from "@/components/admin/NewLaunchForm";

export const dynamic = "force-dynamic";

export default function NewLaunchPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="space-y-1">
        <p className="text-xs uppercase tracking-wide text-neutral-400">Active Launches</p>
        <h1 className="text-xl font-semibold">New Launch</h1>
        <p className="text-sm text-neutral-500">
          Spin up a new waitlist for this launch. Set the essentials here — the
          full journey, audience, and branding live in the launch&apos;s tabs
          once it exists.
        </p>
      </div>
      <NewLaunchForm />
    </div>
  );
}

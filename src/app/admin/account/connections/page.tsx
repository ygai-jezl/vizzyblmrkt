import { Suspense } from "react";
import Link from "next/link";
import { requireAdminContext } from "@/lib/auth/session";
import { isNavV2Phase3Enabled } from "@/lib/nav/flags";
import { ConnectionsPanel } from "@/components/admin/ConnectionsPanel";

export const dynamic = "force-dynamic";

export default async function ConnectionsPage() {
  await requireAdminContext();
  if (!isNavV2Phase3Enabled()) {
    return (
      <Suspense>
        <ConnectionsPanel />
      </Suspense>
    );
  }
  return (
    <div className="space-y-4">
      {/* Nav v2 phase 3: "connection" now means only these sign-ins; products have their own page. */}
      <p className="max-w-3xl text-sm text-neutral-500 dark:text-neutral-400">
        Accounts you sign in to. GitHub here is the same connection Products uses to learn your product from its repo.
        Your product&rsquo;s API keys live in{" "}
        <Link href="/admin/products" className="underline underline-offset-2">
          Products
        </Link>
        .
      </p>
      <Suspense>
        <ConnectionsPanel />
      </Suspense>
    </div>
  );
}

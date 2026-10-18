import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import { isOrderGuardsEnabled } from "@/lib/guards/flags";
import { resolveSender } from "@/lib/email/sender";
import { getTenantById } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { Campaign } from "@/lib/types/campaign";

/**
 * The order guard on a launch: while neither the brand nor the launch has a From
 * address on a verified domain, its sign-up, welcome and invite emails go out from
 * the platform's shared default address. Say so where the launch's emails are run.
 * Server component; renders nothing when the sender is fine or the guards are off.
 */
export async function LaunchSenderWarning({
  ctx,
  campaign,
}: {
  ctx: TenantContext;
  campaign: Pick<Campaign, "emailFromAddress" | "emailFromName" | "emailReplyTo"> | null;
}) {
  if (!isOrderGuardsEnabled()) return null;
  const tenant = await getTenantById(ctx.tenantId).catch(() => null);
  if (!tenant || resolveSender(tenant, campaign).fromEmail) return null;
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
    >
      <TriangleAlert size={16} aria-hidden className="mt-0.5 shrink-0" />
      <p>
        This launch&apos;s emails come from a shared default address until you verify your sending domain.{" "}
        <Link href="/admin/account" className="font-medium underline">
          Set it up in Settings › Sending
        </Link>
      </p>
    </div>
  );
}

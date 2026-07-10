import type { Metadata } from "next";
import { verifyUnsubscribeToken } from "@/lib/email/unsubscribeToken";
import { getTenantById } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { resolveFooterBrand } from "@/lib/email/sender";
import { resolvePrivacyUrl } from "@/lib/email/footer";
import { isSuppressed } from "@/lib/email/suppression";
import { UnsubscribeConfirm } from "./UnsubscribeConfirm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Email preferences",
  robots: { index: false, follow: false },
};

/**
 * Hosted preference / unsubscribe page. Both the footer's "Manage preferences"
 * and "Unsubscribe" links land here (a GET with the signed `?u=` token). The
 * page verifies the token, shows the brand + current status, and offers a
 * one-click Unsubscribe (which POSTs to /api/unsubscribe). Tenant-wide: the
 * opt-out stops journeys AND broadcasts (see applyUnsubscribe).
 */

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-50 p-6 dark:bg-neutral-950">
      <div className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-8 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        {children}
      </div>
    </main>
  );
}

export default async function UnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const token = typeof sp.u === "string" ? sp.u : "";
  const verified = verifyUnsubscribeToken(token);

  if (!verified.ok) {
    return (
      <Shell>
        <h1 className="text-lg font-semibold text-neutral-900 dark:text-white">
          Email preferences
        </h1>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-300">
          This unsubscribe link is invalid or has expired. If you keep receiving unwanted email,
          please contact the sender directly.
        </p>
      </Shell>
    );
  }

  const { claims } = verified;
  const tenant = await getTenantById(claims.tenantId).catch(() => null);
  const brand = resolveFooterBrand(tenant, null);
  const privacyUrl = resolvePrivacyUrl(tenant);

  // Show the current state so a re-visit after a one-click unsubscribe reads right.
  let already = false;
  if (tenant) {
    const ctx: TenantContext = { tenantId: tenant.id, region: tenant.region, source: "system" };
    already = await isSuppressed(ctx, claims.email).catch(() => false);
  }

  return (
    <Shell>
      <h1 className="text-lg font-semibold text-neutral-900 dark:text-white">Email preferences</h1>
      <div className="mt-3">
        {already ? (
          <p className="text-sm text-neutral-600 dark:text-neutral-300">
            You&rsquo;re unsubscribed from marketing emails from {brand}
            {claims.email ? ` (${claims.email})` : ""}. No further action is needed.
          </p>
        ) : (
          <UnsubscribeConfirm token={token} brand={brand} email={claims.email} />
        )}
      </div>
      <p className="mt-6 border-t border-neutral-100 pt-4 text-xs text-neutral-400 dark:border-neutral-800">
        <a href={privacyUrl} className="underline hover:text-neutral-600 dark:hover:text-neutral-200">
          Privacy Policy
        </a>
      </p>
    </Shell>
  );
}

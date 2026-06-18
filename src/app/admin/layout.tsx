import { requireAdminContext } from "@/lib/auth/session";
import {
  forTenant,
  getTenantById,
  getTenantsForUser,
  deriveFaviconUrl,
} from "@/lib/tenant";
import { AdminSidebar } from "@/components/admin/AdminSidebar";
import type { BrandOption } from "@/components/admin/BrandSwitcher";

export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await requireAdminContext();

  // requireAdminContext() returns only token claims (ids), so read the tenant
  // record for the brand, the campaigns to list as launches, and the user's
  // brand memberships to populate the brand switcher.
  const [tenant, campaigns, memberships] = await Promise.all([
    getTenantById(ctx.tenantId),
    forTenant(ctx).campaigns.find({ orderBy: [["createdAt", "desc"]], limit: 50 }),
    // The switcher is non-essential chrome: a registry blip or a legacy/unparseable
    // membership doc must NOT take down the whole admin shell, so degrade to no
    // memberships (the home brand is still added below).
    ctx.userId ? getTenantsForUser(ctx.userId).catch(() => []) : Promise.resolve([]),
  ]);

  const brand = {
    name: tenant?.tenantName ?? ctx.tenantId,
    // Prefer the stored favicon; derive from the domain for legacy tenant docs
    // that predate the field; BrandFavicon shows a monogram if it still fails.
    faviconUrl:
      tenant?.faviconUrl || (tenant ? deriveFaviconUrl(tenant.rootDomain) : undefined),
  };

  // Brand switcher list = the current/home tenant (always shown, even with no
  // membership row) ∪ the user's memberships, deduped. Reuse the home tenant doc
  // already fetched above; read the rest. Suspended brands are dropped so you
  // can't switch into one.
  const brandIds = [...new Set([ctx.tenantId, ...memberships.map((m) => m.tenantId)])];
  const brandDocs = await Promise.all(
    // Per-doc resilience: one bad/unparseable brand doc is skipped, not fatal.
    brandIds.map((id) =>
      id === ctx.tenantId ? tenant : getTenantById(id).catch(() => null),
    ),
  );
  const brands: BrandOption[] = brandDocs
    .filter((t): t is NonNullable<typeof t> => !!t && t.status !== "suspended")
    .map((t) => ({
      tenantId: t.id,
      name: t.tenantName,
      faviconUrl: t.faviconUrl || deriveFaviconUrl(t.rootDomain),
      active: t.id === ctx.tenantId,
    }));

  // Guarantee the current brand is always present/selectable, even if its
  // tenant doc is missing or suspended (so the switcher never renders empty).
  if (!brands.some((b) => b.active)) {
    brands.unshift({
      tenantId: ctx.tenantId,
      name: brand.name,
      faviconUrl: brand.faviconUrl,
      active: true,
    });
  }

  const launches = campaigns.map((c) => ({ id: c.id, name: c.waitlistName }));

  return (
    <div className="flex min-h-screen">
      <AdminSidebar
        brands={brands}
        launches={launches}
        ctx={{
          tenantId: ctx.tenantId,
          region: ctx.region,
          role: ctx.role ?? "member",
        }}
      />
      <main className="min-w-0 flex-1 px-6 py-6">{children}</main>
    </div>
  );
}

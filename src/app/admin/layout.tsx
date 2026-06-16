import { requireAdminContext } from "@/lib/auth/session";
import { forTenant, getTenantById, deriveFaviconUrl } from "@/lib/tenant";
import { AdminSidebar } from "@/components/admin/AdminSidebar";

export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await requireAdminContext();

  // requireAdminContext() returns only token claims (ids), so read the tenant
  // record for the brand, and the campaigns to list as launches in the sidebar.
  const [tenant, campaigns] = await Promise.all([
    getTenantById(ctx.tenantId),
    forTenant(ctx).campaigns.find({ orderBy: [["createdAt", "desc"]], limit: 50 }),
  ]);

  const brand = {
    name: tenant?.tenantName ?? ctx.tenantId,
    // Prefer the stored favicon; derive from the domain for legacy tenant docs
    // that predate the field; BrandFavicon shows a monogram if it still fails.
    faviconUrl:
      tenant?.faviconUrl || (tenant ? deriveFaviconUrl(tenant.rootDomain) : undefined),
  };
  const launches = campaigns.map((c) => ({ id: c.id, name: c.waitlistName }));

  return (
    <div className="flex min-h-screen">
      <AdminSidebar
        brand={brand}
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

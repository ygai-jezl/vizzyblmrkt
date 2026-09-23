import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getAdminContextWithHome } from "@/lib/auth/session";
import {
  forTenant,
  getTenantById,
  getTenantsForUser,
  deriveFaviconUrl,
} from "@/lib/tenant";
import { AdminSidebar } from "@/components/admin/AdminSidebar";
import { SessionKeeper } from "@/components/admin/SessionKeeper";
import type { BrandOption } from "@/components/admin/BrandSwitcher";
import { AdminThemeRoot } from "@/components/admin/nav/AdminThemeRoot";
import { AdminHeader } from "@/components/admin/nav/AdminHeader";
import { SidebarV2 } from "@/components/admin/nav/SidebarV2";
import { ShellProvider } from "@/components/admin/nav/ShellProvider";
import { VizzyPanel } from "@/components/admin/nav/VizzyPanel";
import { CommandPalette } from "@/components/admin/nav/CommandPalette";
import { isNavV2Enabled, isNavV2Phase2Enabled, isThemeSwitchEnabled } from "@/lib/nav/flags";
import { parseThemePreference, THEME_COOKIE } from "@/lib/theme";

export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getAdminContextWithHome();
  if (!session) redirect("/login");
  const { ctx, homeTenantId } = session;

  // requireAdminContext() returns only token claims (ids), so read the tenant
  // record for the brand, the campaigns to list as launches, and the user's
  // brand memberships to populate the brand switcher.
  const navV2 = isNavV2Enabled();
  const [tenant, campaigns, memberships, workspaces] = await Promise.all([
    getTenantById(ctx.tenantId),
    forTenant(ctx).campaigns.find({ orderBy: [["createdAt", "desc"]], limit: 50 }),
    // The switcher is non-essential chrome: a registry blip or a legacy/unparseable
    // membership doc must NOT take down the whole admin shell, so degrade to no
    // memberships (the home brand is still added below).
    ctx.userId ? getTenantsForUser(ctx.userId).catch(() => []) : Promise.resolve([]),
    // Nav v2 breadcrumbs name workspaces; like the switcher, never fatal.
    navV2
      ? forTenant(ctx).workspaces.find({ where: [], limit: 200 }).catch(() => [])
      : Promise.resolve([]),
  ]);

  const brand = {
    name: tenant?.tenantName ?? ctx.tenantId,
    // Prefer the stored favicon; derive from the domain for legacy tenant docs
    // that predate the field; BrandFavicon shows a monogram if it still fails.
    faviconUrl:
      tenant?.faviconUrl || (tenant ? deriveFaviconUrl(tenant.rootDomain) : undefined),
  };

  // Brand switcher list = the home tenant (claims; always shown, even with no
  // membership row) ∪ the active tenant ∪ the user's memberships, deduped. Using
  // the HOME id here (not just the active one) is what keeps the home brand in
  // the list after the user switches into another brand. Suspended brands are
  // dropped so you can't switch into one.
  const brandIds = [
    ...new Set([homeTenantId, ctx.tenantId, ...memberships.map((m) => m.tenantId)]),
  ];
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

  // Archived launches are "closed" but preserved; split them out so they sit in
  // a separate, collapsed sidebar section instead of cluttering Active Launches.
  const launches = campaigns
    .filter((c) => !c.archivedAt)
    .map((c) => ({ id: c.id, name: c.waitlistName }));
  const archivedLaunches = campaigns
    .filter((c) => !!c.archivedAt)
    .map((c) => ({ id: c.id, name: c.waitlistName }));

  const sidebarCtx = {
    tenantId: ctx.tenantId,
    region: ctx.region,
    role: ctx.role ?? "member",
  };

  if (navV2) {
    // Server-side read of an explicit theme choice, so the first paint is already
    // right. System (no cookie) leaves `dark:` following the OS, as before.
    const theme = isThemeSwitchEnabled()
      ? parseThemePreference((await cookies()).get(THEME_COOKIE)?.value)
      : "system";
    const crumbNames = {
      launches: Object.fromEntries([...launches, ...archivedLaunches].map((l) => [l.id, l.name])),
      workspaces: Object.fromEntries(workspaces.map((w) => [w.id, w.name])),
    };
    const phase2 = isNavV2Phase2Enabled();
    const shell = (
      <>
        <SessionKeeper />
        <SidebarV2
          brands={brands}
          launches={launches}
          archivedLaunches={archivedLaunches}
          ctx={sidebarCtx}
          email={ctx.email}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <AdminHeader names={crumbNames} />
          <main className="min-w-0 flex-1 px-6 py-6">{children}</main>
        </div>
        {phase2 ? <VizzyPanel /> : null}
        {phase2 ? (
          <CommandPalette
            launches={launches}
            archivedLaunches={archivedLaunches}
            workspaces={workspaces.filter((w) => !w.archivedAt).map((w) => ({ id: w.id, name: w.name }))}
          />
        ) : null}
      </>
    );
    return (
      <AdminThemeRoot initial={theme}>
        {/* Keyed by brand: switching brand starts a fresh Vizzy conversation. */}
        {phase2 ? (
          <ShellProvider key={ctx.tenantId} names={crumbNames}>
            {shell}
          </ShellProvider>
        ) : (
          shell
        )}
      </AdminThemeRoot>
    );
  }

  return (
    <div className="flex min-h-screen">
      <SessionKeeper />
      <AdminSidebar
        brands={brands}
        launches={launches}
        archivedLaunches={archivedLaunches}
        ctx={sidebarCtx}
      />
      <main className="min-w-0 flex-1 px-6 py-6">{children}</main>
    </div>
  );
}

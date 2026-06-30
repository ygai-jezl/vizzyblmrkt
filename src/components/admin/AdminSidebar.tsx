"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  CheckSquare,
  Rocket,
  Plus,
  Users,
  Database,
  Radar,
  LineChart,
  GitBranch,
  FolderKanban,
  Settings,
  Archive,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  type LucideIcon,
} from "lucide-react";
import { BrandSwitcher, type BrandOption } from "./BrandSwitcher";
import { LogoutButton } from "./LogoutButton";

interface NavLink {
  href: string;
  label: string;
  icon: LucideIcon;
  /** startsWith match for highlighting child routes; omit for an exact match. */
  matchPattern?: string;
  badge?: number;
}

interface NavGroup {
  title: string;
  items: NavLink[];
}

export interface AdminSidebarProps {
  brands: BrandOption[];
  launches: Array<{ id: string; name: string }>;
  /** Archived (closed) launches — rendered in a separate, collapsed section. */
  archivedLaunches: Array<{ id: string; name: string }>;
  ctx: { tenantId: string; region: string; role: string };
}

const STATIC_GROUPS: NavGroup[] = [
  {
    title: "Command Center",
    items: [
      // Dashboard is an EXACT match on /admin so it doesn't light up for every
      // child route (which all start with /admin).
      { href: "/admin", label: "Dashboard", icon: LayoutDashboard },
      {
        href: "/admin/approvals",
        label: "Approval Queue",
        icon: CheckSquare,
        matchPattern: "/admin/approvals",
        badge: 3,
      },
    ],
  },
  {
    title: "Content OS",
    items: [
      {
        href: "/admin/workspace",
        label: "Workspace",
        icon: FolderKanban,
        matchPattern: "/admin/workspace",
      },
    ],
  },
  // "Active Launches" is rendered separately (dynamic list).
  {
    title: "Data Engine",
    items: [
      { href: "/admin/crm", label: "Unified CRM", icon: Users, matchPattern: "/admin/crm" },
      { href: "/admin/database", label: "Master Database", icon: Database, matchPattern: "/admin/database" },
      { href: "/admin/identity", label: "Identity Radar", icon: Radar, matchPattern: "/admin/identity" },
    ],
  },
  {
    title: "Strategy Hub",
    items: [
      { href: "/admin/intelligence", label: "Market Intelligence", icon: LineChart, matchPattern: "/admin/intelligence" },
      { href: "/admin/scenarios", label: "Scenario Planner", icon: GitBranch, matchPattern: "/admin/scenarios" },
    ],
  },
];

const NEW_LAUNCH_LINK: NavLink = {
  href: "/admin/launches/new",
  label: "New Launch",
  icon: Plus,
  matchPattern: "/admin/launches/new",
};

// Pinned at the bottom (above sign out). Global, tenant-wide account settings.
const ACCOUNT_LINK: NavLink = {
  href: "/admin/account",
  label: "Account Settings",
  icon: Settings,
  matchPattern: "/admin/account",
};

export function AdminSidebar({
  brands,
  launches,
  archivedLaunches,
  ctx,
}: AdminSidebarProps) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);

  const launchLinks: NavLink[] = launches.map((l) => ({
    href: `/admin/launches/${l.id}`,
    label: l.name,
    icon: Rocket,
    matchPattern: `/admin/launches/${l.id}`,
  }));

  const archivedLinks: NavLink[] = archivedLaunches.map((l) => ({
    href: `/admin/launches/${l.id}`,
    label: l.name,
    icon: Archive,
    matchPattern: `/admin/launches/${l.id}`,
  }));

  // Every link that participates in active-state resolution.
  const allLinks: NavLink[] = [
    ...STATIC_GROUPS.flatMap((g) => g.items),
    ...launchLinks,
    ...archivedLinks,
    NEW_LAUNCH_LINK,
    ACCOUNT_LINK,
  ];

  const matches = (link: NavLink) =>
    link.matchPattern
      ? (pathname?.startsWith(link.matchPattern) ?? false)
      : pathname === link.href;

  // Longest matching pattern wins, so a child route highlights the most
  // specific item (e.g. /admin/launches/x/signups → that launch, not Dashboard).
  const isActive = (link: NavLink) => {
    if (!matches(link)) return false;
    const thisScore = (link.matchPattern ?? link.href).length;
    const winner = allLinks
      .filter(matches)
      .reduce((best, l) => Math.max(best, (l.matchPattern ?? l.href).length), 0);
    return thisScore === winner;
  };

  const renderLink = (link: NavLink) => {
    const Icon = link.icon;
    const active = isActive(link);
    return (
      <Link
        key={link.href}
        href={link.href}
        title={collapsed ? link.label : undefined}
        className={`flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors ${
          collapsed ? "justify-center" : ""
        } ${
          active
            ? "bg-neutral-100 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
            : "text-neutral-500 hover:bg-neutral-50 hover:text-neutral-900 dark:hover:bg-neutral-900 dark:hover:text-neutral-100"
        }`}
      >
        <Icon size={18} className="shrink-0" />
        {!collapsed && <span className="flex-1 truncate">{link.label}</span>}
        {!collapsed && link.badge ? (
          <span className="rounded-full bg-neutral-200 px-1.5 text-xs font-medium tabular-nums text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200">
            {link.badge}
          </span>
        ) : null}
      </Link>
    );
  };

  const sectionHeader = (title: string) =>
    collapsed ? (
      <div className="mx-2 my-2 border-t border-neutral-200 dark:border-neutral-800" />
    ) : (
      <div className="px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
        {title}
      </div>
    );

  return (
    <aside
      className={`sticky top-0 flex h-screen shrink-0 flex-col border-r border-neutral-200 bg-white transition-[width] duration-200 dark:border-neutral-800 dark:bg-neutral-950 ${
        collapsed ? "w-16" : "w-64"
      }`}
    >
      {/* Brand switcher + collapse toggle */}
      <div className="flex items-center justify-between gap-2 border-b border-neutral-200 px-3 py-3 dark:border-neutral-800">
        <BrandSwitcher brands={brands} collapsed={collapsed} />
        {!collapsed && (
          <button
            onClick={() => setCollapsed(true)}
            aria-label="Collapse sidebar"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          >
            <ChevronLeft size={16} />
          </button>
        )}
      </div>
      {collapsed && (
        <button
          onClick={() => setCollapsed(false)}
          aria-label="Expand sidebar"
          className="mx-auto mt-2 grid h-7 w-7 place-items-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
        >
          <ChevronRight size={16} />
        </button>
      )}

      {/* Nav */}
      <nav className="flex-1 space-y-3 overflow-y-auto px-2 py-3">
        {/* Command Center */}
        <div className="space-y-0.5">
          {sectionHeader(STATIC_GROUPS[0]!.title)}
          {STATIC_GROUPS[0]!.items.map(renderLink)}
        </div>

        {/* Active Launches (dynamic) */}
        <div className="space-y-0.5">
          {sectionHeader("Active Launches")}
          {launchLinks.length === 0 && !collapsed ? (
            <p className="px-2.5 py-1.5 text-xs text-neutral-400">No launches yet</p>
          ) : (
            launchLinks.map(renderLink)
          )}
          {renderLink(NEW_LAUNCH_LINK)}
        </div>

        {/* Archived launches (closed but preserved) — collapsible, hidden when
            empty. Auto-expands when the current route is an archived launch. */}
        {archivedLinks.length > 0 &&
          (collapsed ? (
            <div className="space-y-0.5">
              <div className="mx-2 my-2 border-t border-neutral-200 dark:border-neutral-800" />
              {archivedLinks.map(renderLink)}
            </div>
          ) : (
            <div className="space-y-0.5">
              <button
                type="button"
                onClick={() => setArchivedOpen((v) => !v)}
                className="flex w-full items-center justify-between px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
              >
                <span>Archived</span>
                {archivedOpen || archivedLinks.some(isActive) ? (
                  <ChevronDown size={12} />
                ) : (
                  <ChevronRight size={12} />
                )}
              </button>
              {(archivedOpen || archivedLinks.some(isActive)) &&
                archivedLinks.map(renderLink)}
            </div>
          ))}

        {/* Data Engine + Strategy Hub */}
        {STATIC_GROUPS.slice(1).map((group) => (
          <div key={group.title} className="space-y-0.5">
            {sectionHeader(group.title)}
            {group.items.map(renderLink)}
          </div>
        ))}
      </nav>

      {/* Pinned: global account settings (above sign out) */}
      <div className="border-t border-neutral-200 px-2 py-2 dark:border-neutral-800">
        {renderLink(ACCOUNT_LINK)}
      </div>

      {/* Tenant context + sign out */}
      <div className="border-t border-neutral-200 px-3 py-3 dark:border-neutral-800">
        {collapsed ? (
          <div className="flex justify-center">
            <LogoutButton variant="icon" />
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-xs text-neutral-400">
              {ctx.tenantId} · {ctx.region} · {ctx.role}
            </span>
            <LogoutButton />
          </div>
        )}
      </div>
    </aside>
  );
}

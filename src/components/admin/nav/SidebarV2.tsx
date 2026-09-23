"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Archive,
  Box,
  ChartLine,
  ChevronLeft,
  ChevronRight,
  House,
  Inbox,
  PenLine,
  Rocket,
  Route,
  Settings,
  SwatchBook,
  Users,
  type LucideIcon,
} from "lucide-react";
import { BrandSwitcher, type BrandOption } from "../BrandSwitcher";
import { isBrandKitUiEnabled } from "@/lib/content/brandKit";
import { isLifecycleUiEnabled } from "@/lib/lifecycle/flags";
import { activeNavKey, buildNav, resolvePins, type LaunchRef, type NavItem, type NavKey } from "@/lib/nav/model";
import { usePinnedLaunchIds } from "./pins";
import { ProfileMenu } from "./ProfileMenu";
import { useApprovalCount } from "./useApprovalCount";

const ICONS: Record<NavKey, LucideIcon> = {
  home: House,
  review: Inbox,
  launches: Rocket,
  content: PenLine,
  products: Box,
  journeys: Route,
  audience: Users,
  insights: ChartLine,
  brand: SwatchBook,
  settings: Settings,
};

// NEXT_PUBLIC_* flags are inlined at build, so this evaluates once.
const SECTIONS = buildNav({ lifecycle: isLifecycleUiEnabled(), brandKit: isBrandKitUiEnabled() });
const ALL_ITEMS = SECTIONS.flatMap((s) => s.items);

export interface SidebarV2Props {
  brands: BrandOption[];
  launches: LaunchRef[];
  archivedLaunches: LaunchRef[];
  ctx: { tenantId: string; region: string; role: string };
  email?: string;
}

/**
 * The "Growth Path" sidebar (nav v2): Home and Review first; Grow in the order a
 * customer reaches each area; Understand for what spans every stage; pinned
 * launches instead of one row per launch; Brand and Settings at the bottom.
 */
export function SidebarV2({ brands, launches, archivedLaunches, ctx, email }: SidebarV2Props) {
  const pathname = usePathname() ?? "/admin";
  const approvalCount = useApprovalCount();
  const [collapsed, setCollapsed] = useState(false);
  const [storedPins] = usePinnedLaunchIds(ctx.tenantId);
  const pins = resolvePins(storedPins, launches, archivedLaunches);
  const archivedIds = new Set(archivedLaunches.map((l) => l.id));
  const activeKey = activeNavKey(pathname, ALL_ITEMS);

  const rowClass = (tone: "on" | "here" | "idle") =>
    `flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors ${collapsed ? "justify-center" : ""} ${
      tone === "on"
        ? "bg-neutral-100 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
        : tone === "here"
          ? "font-medium text-neutral-900 hover:bg-neutral-50 dark:text-neutral-100 dark:hover:bg-neutral-900"
          : "text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-900 dark:hover:text-neutral-100"
    }`;

  const renderItem = (item: NavItem) => {
    const Icon = ICONS[item.key];
    const on = activeKey === item.key;
    const badge = item.key === "review" ? approvalCount : 0;
    return (
      <Link
        key={item.key}
        href={item.href}
        title={collapsed ? item.label : undefined}
        aria-current={on ? "page" : undefined}
        className={rowClass(on ? "on" : "idle")}
      >
        <Icon size={18} aria-hidden className="shrink-0" />
        {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
        {!collapsed && badge ? (
          <span className="rounded-full bg-neutral-200 px-1.5 text-xs font-medium tabular-nums text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200">
            {badge}
          </span>
        ) : null}
      </Link>
    );
  };

  const heading = (title: string) =>
    collapsed ? (
      <div className="mx-2 my-2 border-t border-neutral-200 dark:border-neutral-800" />
    ) : (
      <div className="px-2.5 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
        {title}
      </div>
    );

  const section = (key: string) => SECTIONS.find((s) => s.key === key)!;
  const renderSection = (key: "start" | "grow" | "understand") => {
    const s = section(key);
    return (
      <div key={key} className="space-y-0.5">
        {s.title && heading(s.title)}
        {s.items.map(renderItem)}
      </div>
    );
  };

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

      <nav aria-label="Main" className="flex-1 space-y-2 overflow-y-auto px-2 py-3">
        {renderSection("start")}
        {renderSection("grow")}
        {renderSection("understand")}

        {/* Pinned launches: the newest three until the user stars their own on the Launches page. */}
        {pins.length > 0 && (
          <div className="space-y-0.5">
            {heading("Pinned")}
            {pins.map((l) => {
              const href = `/admin/launches/${l.id}`;
              const here = pathname === href || pathname.startsWith(`${href}/`);
              const Icon = archivedIds.has(l.id) ? Archive : Rocket;
              return (
                <Link
                  key={l.id}
                  href={href}
                  title={collapsed ? l.name : undefined}
                  className={rowClass(here ? "here" : "idle")}
                >
                  <Icon size={18} aria-hidden className="shrink-0" />
                  {!collapsed && <span className="flex-1 truncate">{l.name}</span>}
                </Link>
              );
            })}
          </div>
        )}
      </nav>

      <div className="space-y-0.5 border-t border-neutral-200 px-2 py-2 dark:border-neutral-800">
        {section("end").items.map(renderItem)}
      </div>

      <div className="border-t border-neutral-200 px-2 py-2 dark:border-neutral-800">
        <ProfileMenu email={email} role={ctx.role} tenantId={ctx.tenantId} region={ctx.region} collapsed={collapsed} />
      </div>
    </aside>
  );
}

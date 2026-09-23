"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Archive,
  Box,
  ChartLine,
  Check,
  ChevronLeft,
  ChevronRight,
  House,
  Inbox,
  PenLine,
  Rocket,
  Route,
  Search,
  Settings,
  Sparkles,
  SwatchBook,
  Users,
  type LucideIcon,
} from "lucide-react";
import { BrandSwitcher, type BrandOption } from "../BrandSwitcher";
import { isBrandKitUiEnabled } from "@/lib/content/brandKit";
import { isLifecycleUiEnabled } from "@/lib/lifecycle/flags";
import { isNavV2Phase2Enabled } from "@/lib/nav/flags";
import { STAGE_NAV_KEY, type StageKey, type StageStatus } from "@/lib/nav/growth";
import { activeNavKey, buildNav, resolvePins, type LaunchRef, type NavItem, type NavKey } from "@/lib/nav/model";
import { usePinnedLaunchIds } from "./pins";
import { ProfileMenu } from "./ProfileMenu";
import { useShell } from "./ShellProvider";
import { useReviewCount } from "./useApprovalCount";

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

// NEXT_PUBLIC_* flags are inlined at build, so these evaluate once.
const PHASE2 = isNavV2Phase2Enabled();
const SECTIONS = buildNav({
  lifecycle: isLifecycleUiEnabled(),
  brandKit: isBrandKitUiEnabled(),
  // Phase 2's Review also holds failed posts, Vizzy drafts and content sign-off.
  review: isLifecycleUiEnabled() || PHASE2,
});
const ALL_ITEMS = SECTIONS.flatMap((s) => s.items);

export interface SidebarV2Props {
  brands: BrandOption[];
  launches: LaunchRef[];
  archivedLaunches: LaunchRef[];
  ctx: { tenantId: string; region: string; role: string };
  email?: string;
}

interface GrowthDots {
  byNav: Partial<Record<NavKey, StageStatus>>;
  position: string | null;
}

/**
 * Growth-path progress for the Grow items (phase 2). Fetched after load so it
 * never slows the page; refreshed every five minutes. Hidden once every stage
 * is running.
 */
function useGrowthDots(): GrowthDots | null {
  const [dots, setDots] = useState<GrowthDots | null>(null);
  useEffect(() => {
    if (!PHASE2) return;
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/admin/growth");
        if (!res.ok) return;
        const data = (await res.json()) as { stages?: Array<{ key: StageKey; status: StageStatus }>; allRunning?: boolean };
        if (!alive || !data.stages) return;
        if (data.allRunning) return setDots(null);
        const current = data.stages.findIndex((s) => s.status === "current");
        setDots({
          byNav: Object.fromEntries(data.stages.map((s) => [STAGE_NAV_KEY[s.key], s.status])),
          position: current >= 0 ? `Stage ${current + 1} of ${data.stages.length}` : null,
        });
      } catch {
        // Offline — keep the last dots.
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5 * 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  return dots;
}

const STATUS_TEXT: Record<StageStatus, string> = {
  done: "done",
  current: "current stage",
  next: "not started",
};

function StageDot({ status }: { status: StageStatus }) {
  return (
    <span className="ml-auto grid h-4 w-4 shrink-0 place-items-center" title={STATUS_TEXT[status]}>
      {status === "done" ? (
        <Check size={13} strokeWidth={3} aria-hidden className="text-shell-muted" />
      ) : status === "current" ? (
        <span aria-hidden className="h-2 w-2 rounded-full bg-shell-accent ring-4 ring-shell-accent-soft" />
      ) : (
        <span aria-hidden className="h-2 w-2 rounded-full border border-shell-faint" />
      )}
      <span className="sr-only">({STATUS_TEXT[status]})</span>
    </span>
  );
}

/**
 * The "Growth Path" sidebar (nav v2): Home and Review first; Grow in the order a
 * customer reaches each area; Understand for what spans every stage; pinned
 * launches instead of one row per launch; Brand and Settings at the bottom.
 * Phase 2 adds search (⌘K), Ask Vizzy (⌘J) and the growth-path dots.
 */
export function SidebarV2({ brands, launches, archivedLaunches, ctx, email }: SidebarV2Props) {
  const pathname = usePathname() ?? "/admin";
  const shell = useShell();
  const reviewCount = useReviewCount();
  const growth = useGrowthDots();
  const [collapsed, setCollapsed] = useState(false);
  const [mod, setMod] = useState("⌘");
  const [storedPins] = usePinnedLaunchIds(ctx.tenantId);
  const pins = resolvePins(storedPins, launches, archivedLaunches);
  const archivedIds = new Set(archivedLaunches.map((l) => l.id));
  const activeKey = activeNavKey(pathname, ALL_ITEMS);

  useEffect(() => {
    if (!/Mac|iPhone|iPad/.test(navigator.userAgent)) setMod("Ctrl ");
  }, []);

  const rowClass = (tone: "on" | "here" | "idle") =>
    `flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors ${collapsed ? "justify-center" : ""} ${
      tone === "on"
        ? "bg-shell-active font-medium text-shell-ink"
        : tone === "here"
          ? "font-medium text-shell-ink hover:bg-shell-hover"
          : "text-shell-muted hover:bg-shell-hover hover:text-shell-ink"
    }`;

  const kbd = (keys: string) =>
    collapsed ? null : (
      <kbd className="ml-auto rounded border border-shell-line px-1 font-mono text-[10.5px] text-shell-faint">{keys}</kbd>
    );

  const renderItem = (item: NavItem) => {
    const Icon = ICONS[item.key];
    const on = activeKey === item.key;
    const badge = item.key === "review" ? reviewCount : 0;
    const stage = growth?.byNav[item.key];
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
          <span className="rounded-full bg-shell-line px-1.5 text-xs font-medium tabular-nums text-shell-ink">{badge}</span>
        ) : null}
        {!collapsed && stage ? <StageDot status={stage} /> : null}
      </Link>
    );
  };

  const heading = (title: string, note?: string | null) =>
    collapsed ? (
      <div className="mx-2 my-2 border-t border-shell-line" />
    ) : (
      <div className="flex items-baseline justify-between px-2.5 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-shell-muted">
        <span>{title}</span>
        {note ? <span className="font-medium normal-case tracking-normal text-shell-faint">{note}</span> : null}
      </div>
    );

  const section = (key: string) => SECTIONS.find((s) => s.key === key)!;
  const renderSection = (key: "start" | "grow" | "understand") => {
    const s = section(key);
    return (
      <div key={key} className="space-y-0.5">
        {s.title && heading(s.title, key === "grow" ? growth?.position : null)}
        {s.items.map(renderItem)}
        {key === "start" && shell ? (
          <button
            type="button"
            onClick={shell.toggleVizzy}
            title={collapsed ? "Ask Vizzy" : undefined}
            aria-pressed={shell.vizzyOpen}
            className={`${rowClass(shell.vizzyOpen ? "on" : "idle")} !text-shell-accent`}
          >
            <Sparkles size={18} aria-hidden className="shrink-0" />
            {!collapsed && <span className="flex-1 truncate">Ask Vizzy</span>}
            {kbd(`${mod}J`)}
          </button>
        ) : null}
      </div>
    );
  };

  return (
    <aside
      className={`sticky top-0 flex h-screen shrink-0 flex-col border-r border-shell-line bg-shell-side text-shell-ink transition-[width] duration-200 ${
        collapsed ? "w-16" : "w-64"
      }`}
    >
      {/* Brand switcher + collapse toggle */}
      <div className="flex items-center justify-between gap-2 border-b border-shell-line px-3 py-3">
        <BrandSwitcher brands={brands} collapsed={collapsed} />
        {!collapsed && (
          <button
            onClick={() => setCollapsed(true)}
            aria-label="Collapse sidebar"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-shell-faint hover:bg-shell-hover hover:text-shell-ink"
          >
            <ChevronLeft size={16} />
          </button>
        )}
      </div>
      {collapsed && (
        <button
          onClick={() => setCollapsed(false)}
          aria-label="Expand sidebar"
          className="mx-auto mt-2 grid h-7 w-7 place-items-center rounded-md text-shell-faint hover:bg-shell-hover hover:text-shell-ink"
        >
          <ChevronRight size={16} />
        </button>
      )}

      {shell ? (
        <div className="px-2 pt-3">
          <button
            type="button"
            onClick={() => shell.setPaletteOpen(true)}
            title={collapsed ? "Search or jump to" : undefined}
            className={`flex w-full items-center gap-2 rounded-md border border-shell-line bg-shell-card px-2.5 py-1.5 text-left text-sm text-shell-faint hover:text-shell-ink ${
              collapsed ? "justify-center" : ""
            }`}
          >
            <Search size={15} aria-hidden className="shrink-0" />
            {!collapsed && <span className="flex-1 truncate">Search or jump to…</span>}
            {kbd(`${mod}K`)}
          </button>
        </div>
      ) : null}

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

      <div className="space-y-0.5 border-t border-shell-line px-2 py-2">{section("end").items.map(renderItem)}</div>

      <div className="border-t border-shell-line px-2 py-2">
        <ProfileMenu email={email} role={ctx.role} tenantId={ctx.tenantId} region={ctx.region} collapsed={collapsed} />
      </div>
    </aside>
  );
}

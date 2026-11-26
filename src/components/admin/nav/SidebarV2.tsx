"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  BookOpen,
  Archive,
  Box,
  ChartLine,
  Check,
  ChevronLeft,
  ChevronRight,
  House,
  Inbox,
  ListTodo,
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
import { isNavV2Phase2Enabled, isNavV2Phase3Enabled } from "@/lib/nav/flags";
import { STAGE_NAV_KEY, type StageKey, type StageStatus } from "@/lib/nav/growth";
import { openHowTo } from "@/components/help/openHowTo";
import { isSetupGuideEnabled } from "@/lib/help/flags";
import { activeNavKey, buildNav, resolvePins, type LaunchRef, type NavItem, type NavKey } from "@/lib/nav/model";
import { isRevealKey, pathSections, revealKeysOf, shownSections, waitingInView, type RevealKey } from "@/lib/nav/reveal";
import type { SidebarReveal } from "@/lib/onboarding/sidebarFit";
import { ComingUp, type ComingUpItem } from "./ComingUp";
import { usePinnedLaunchIds } from "./pins";
import { ProfileMenu } from "./ProfileMenu";
import { useShell } from "./ShellProvider";
import { useReviewCount } from "./useApprovalCount";

const ICONS: Record<NavKey, LucideIcon> = {
  home: House,
  review: Inbox,
  work: ListTodo,
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
const GUIDE = isSetupGuideEnabled();

/**
 * The sidebar's sections; `people` (from the server) names the Audience item People, `ideas`
 * (from the server) the Launches item Ideas, and `work` (WORK_ENABLED, from the server) adds Work.
 */
function sectionsFor(people: boolean, ideas: boolean, work: boolean) {
  return buildNav({
    lifecycle: isLifecycleUiEnabled(),
    brandKit: isBrandKitUiEnabled(),
    // Phase 2's Review also holds failed posts, Vizzy drafts and content sign-off.
    review: isLifecycleUiEnabled() || PHASE2,
    phase3: isNavV2Phase3Enabled(),
    people,
    ideas,
    work,
  });
}

export interface SidebarV2Props {
  brands: BrandOption[];
  launches: LaunchRef[];
  archivedLaunches: LaunchRef[];
  ctx: { tenantId: string; region: string; role: string };
  email?: string;
  /** Audience is called People (isPeopleNameEnabled(), worked out by the layout on the server). */
  people?: boolean;
  /** Launches are called Ideas (isIdeaWordsEnabled(), worked out by the layout on the server). */
  ideas?: boolean;
  /** Work is on (isWorkEnabled(), worked out by the layout on the server): last in the top group, under Ask Vizzy. */
  work?: boolean;
  /**
   * Coming up (ONBOARDING_ENABLED, worked out by the layout from the tenant doc): the sections this
   * brand shows and each waiting one's line. Undefined: today's sidebar, every section shown.
   */
  reveal?: SidebarReveal;
}

interface GrowthDots {
  byNav: Partial<Record<NavKey, StageStatus>>;
  position: string | null;
}

interface GrowthState {
  /** Null before the first answer, and once every stage is running. */
  dots: GrowthDots | null;
  /** The sections a brand with Coming up shows now (data found since the page was drawn); null without. */
  revealShown: RevealKey[] | null;
  allRunning: boolean;
}

const NO_GROWTH: GrowthState = { dots: null, revealShown: null, allRunning: false };

/**
 * Growth-path progress for the Grow items (phase 2). Fetched after load so it
 * never slows the page; refreshed every five minutes. The dots hide once every
 * stage is running. With Coming up, the sections the brand shows now come with it.
 */
function useGrowth(): GrowthState {
  const [growth, setGrowth] = useState<GrowthState>(NO_GROWTH);
  useEffect(() => {
    if (!PHASE2) return;
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/admin/growth");
        if (!res.ok) return;
        const data = (await res.json()) as {
          stages?: Array<{ key: StageKey; status: StageStatus }>;
          allRunning?: boolean;
          reveal?: { shown?: unknown };
        };
        if (!alive || !data.stages) return;
        const revealShown = Array.isArray(data.reveal?.shown) ? revealKeysOf(data.reveal.shown) : null;
        if (data.allRunning) return setGrowth({ dots: null, revealShown, allRunning: true });
        const current = data.stages.findIndex((s) => s.status === "current");
        setGrowth({
          dots: {
            byNav: Object.fromEntries(
              data.stages.flatMap((s) => (STAGE_NAV_KEY[s.key] ? [[STAGE_NAV_KEY[s.key], s.status]] : [])),
            ),
            position: current >= 0 ? `Stage ${current + 1} of ${data.stages.length}` : null,
          },
          revealShown,
          allRunning: false,
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
  return growth;
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
export function SidebarV2({ brands, launches, archivedLaunches, ctx, email, people = false, ideas = false, work = false, reveal }: SidebarV2Props) {
  const pathname = usePathname() ?? "/admin";
  const router = useRouter();
  const sections = useMemo(() => sectionsFor(people, ideas, work), [people, ideas, work]);
  const allItems = useMemo(() => sections.flatMap((s) => s.items), [sections]);
  const shell = useShell();
  const reviewCount = useReviewCount();
  const { dots: growth, revealShown, allRunning } = useGrowth();
  const [collapsed, setCollapsed] = useState(false);
  const [mod, setMod] = useState("⌘");
  const [storedPins] = usePinnedLaunchIds(ctx.tenantId);
  const pins = resolvePins(storedPins, launches, archivedLaunches);
  const archivedIds = new Set(archivedLaunches.map((l) => l.id));
  const activeKey = activeNavKey(pathname, allItems);

  // Coming up: without `reveal` the sidebar is exactly as before. Sections opened here show at once.
  const [opened, setOpened] = useState<RevealKey[]>([]);
  const shown = useMemo(
    () => shownSections(reveal, { fetched: revealShown, allRunning }, opened),
    [reveal, revealShown, allRunning, opened],
  );
  const view = useMemo(
    () => (shown ? pathSections(sections, shown, activeKey) : { sections, comingUp: [] as NavItem[] }),
    [sections, shown, activeKey],
  );
  const recorded = useRef(new Set<RevealKey>());
  // Show a section for good: Open early, or its page reached another way (⌘K, a link). Once a key.
  const keepShown = useCallback((key: RevealKey) => {
    setOpened((list) => (list.includes(key) ? list : [...list, key]));
    if (recorded.current.has(key)) return;
    recorded.current.add(key);
    void fetch("/api/admin/nav/open", {
      method: "POST",
      keepalive: true,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
    }).catch(() => {});
  }, []);
  const inView = waitingInView(shown, activeKey);
  useEffect(() => {
    if (inView) keepShown(inView);
  }, [inView, keepShown]);
  const comingUp: ComingUpItem[] = reveal
    ? view.comingUp.flatMap((item) =>
        isRevealKey(item.key) ? [{ key: item.key, label: item.label, href: item.href, icon: ICONS[item.key], why: reveal.why[item.key] }] : [],
      )
    : [];

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

  const section = (key: string) => view.sections.find((s) => s.key === key);
  const renderSection = (key: "start" | "grow" | "understand") => {
    // Understand is left out when nothing in it shows (Coming up).
    const s = section(key);
    if (!s) return null;
    // Work belongs to the organisation, not one brand: it sits last in the top group, under Ask Vizzy.
    const after = key === "start" ? s.items.filter((i) => i.key === "work") : [];
    return (
      <div key={key} className="space-y-0.5">
        {s.title && heading(s.title, key === "grow" ? growth?.position : null)}
        {s.items.filter((i) => !after.includes(i)).map(renderItem)}
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
        {after.map(renderItem)}
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

        {comingUp.length > 0 ? (
          <ComingUp
            items={comingUp}
            collapsed={collapsed}
            mod={mod}
            rowClassName={rowClass("idle")}
            onOpen={(item) => {
              keepShown(item.key);
              router.push(item.href);
            }}
          />
        ) : null}

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

      <div className="space-y-0.5 border-t border-shell-line px-2 py-2">
        {GUIDE ? (
          <a
            href="/help"
            target="_blank"
            rel="noopener"
            title={collapsed ? "Help" : undefined}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey) return;
              if (openHowTo("/help")) e.preventDefault();
            }}
            className={rowClass("idle")}
          >
            <BookOpen size={18} aria-hidden className="shrink-0" />
            {!collapsed && <span className="flex-1 truncate">Help</span>}
          </a>
        ) : null}
        {section("end")?.items.map(renderItem)}
      </div>

      <div className="border-t border-shell-line px-2 py-2">
        <ProfileMenu email={email} role={ctx.role} tenantId={ctx.tenantId} region={ctx.region} collapsed={collapsed} />
      </div>
    </aside>
  );
}

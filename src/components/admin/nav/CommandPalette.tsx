"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Command } from "cmdk";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Archive,
  Box,
  ChartLine,
  House,
  Inbox,
  PenLine,
  Plus,
  Rocket,
  Route,
  Search,
  Settings,
  Sparkles,
  SwatchBook,
  Users,
  type LucideIcon,
} from "lucide-react";
import { isBrandKitUiEnabled } from "@/lib/content/brandKit";
import { isLifecycleUiEnabled } from "@/lib/lifecycle/flags";
import { isNavV2Phase3Enabled } from "@/lib/nav/flags";
import { buildNav, type LaunchRef, type NavKey } from "@/lib/nav/model";
import { useThemePortalContainer } from "./AdminThemeRoot";
import { useShell } from "./ShellProvider";

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

/** Other words people use for each area, so "crm" finds Audience. */
const KEYWORDS: Partial<Record<NavKey, string[]>> = {
  review: ["approvals", "inbox", "decisions"],
  launches: ["waitlists", "campaigns"],
  content: ["workspaces", "programmes", "posts", "newsletter"],
  products: ["connections", "app", "sandbox"],
  journeys: ["lifecycle", "emails", "onboarding"],
  audience: ["crm", "people", "contacts", "signups"],
  insights: ["analytics", "metrics"],
  brand: ["voice", "logo", "colours", "brand kit"],
  settings: ["account", "domains", "integrations", "billing"],
};

const lifecycle = isLifecycleUiEnabled();
const PHASE3 = isNavV2Phase3Enabled();
const NAV = buildNav({ lifecycle, brandKit: isBrandKitUiEnabled(), review: true, phase3: PHASE3 }).flatMap((s) => s.items);

const ITEM =
  "flex cursor-pointer items-center gap-2.5 rounded-md px-3 py-2 text-sm text-shell-ink data-[selected=true]:bg-shell-active";

interface LifecycleLists {
  journeys: Array<{ id: string; name: string; connectionName?: string | null }>;
  products: Array<{ id: string; name: string }>;
}

/**
 * ⌘K: jump to any area, launch, workspace, journey or product; create something;
 * search people; or ask Vizzy. Radix Dialog (via cmdk) traps focus and closes on
 * Escape; it renders inside the admin shell so the theme choice applies.
 */
export function CommandPalette({
  launches,
  archivedLaunches,
  workspaces,
}: {
  launches: LaunchRef[];
  archivedLaunches: LaunchRef[];
  workspaces: LaunchRef[];
}) {
  const shell = useShell();
  const router = useRouter();
  const container = useThemePortalContainer();
  const [query, setQuery] = useState("");
  const [lists, setLists] = useState<LifecycleLists | null>(null);
  const open = !!shell?.paletteOpen;

  // Journeys and products load on first open (they aren't in the layout's data).
  useEffect(() => {
    if (!open || lists || !lifecycle) return;
    let alive = true;
    fetch("/api/admin/lifecycle/journeys")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { journeys?: LifecycleLists["journeys"]; connections?: LifecycleLists["products"] } | null) => {
        if (alive && data) setLists({ journeys: data.journeys ?? [], products: data.connections ?? [] });
      })
      .catch(() => {
        // Offline or not allowed: the palette still has everything else.
      });
    return () => {
      alive = false;
    };
  }, [open, lists]);

  if (!shell) return null;
  const q = query.trim();

  const close = () => {
    shell.setPaletteOpen(false);
    setQuery("");
  };
  const go = (href: string) => {
    close();
    router.push(href);
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={(next) => (next ? shell.setPaletteOpen(true) : close())}
      label="Search or jump to"
      container={container ?? undefined}
      overlayClassName="fixed inset-0 z-50 bg-black/40"
      contentClassName="fixed left-1/2 top-[12vh] z-50 w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-xl border border-shell-line bg-shell-raised text-shell-ink shadow-2xl"
    >
      {/* Radix needs a title for screen readers; the input's placeholder says the rest. */}
      <Dialog.Title className="sr-only">Search or jump to</Dialog.Title>
      <Dialog.Description className="sr-only">
        Type to find a page, launch, {PHASE3 ? "programme" : "workspace"}, journey or product, or to ask Vizzy.
      </Dialog.Description>
      <div className="flex items-center gap-2 border-b border-shell-line px-4">
        <Search size={16} aria-hidden className="shrink-0 text-shell-faint" />
        <Command.Input
          value={query}
          onValueChange={setQuery}
          placeholder="Jump to, create, or ask Vizzy…"
          className="h-12 min-w-0 flex-1 bg-transparent text-sm text-shell-ink outline-none placeholder:text-shell-faint"
        />
        <kbd className="rounded border border-shell-line px-1.5 font-mono text-[10.5px] text-shell-muted">esc</kbd>
      </div>
      <Command.List className="max-h-[60vh] overflow-y-auto p-2 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-shell-muted">
        <Command.Empty className="px-3 py-6 text-center text-sm text-shell-muted">No matches.</Command.Empty>

        {q ? (
          <Command.Group heading="Ask or search">
            <Command.Item
              value={`ask ${q}`}
              forceMount
              onSelect={() => {
                close();
                shell.ask(q);
              }}
              className={ITEM}
            >
              <Sparkles size={16} aria-hidden className="shrink-0 text-shell-accent" />
              <span className="truncate">Ask Vizzy: “{q}”</span>
            </Command.Item>
            <Command.Item
              value={`people ${q}`}
              forceMount
              onSelect={() => go(`/admin/crm?q=${encodeURIComponent(q)}`)}
              className={ITEM}
            >
              <Users size={16} aria-hidden className="shrink-0 text-shell-muted" />
              <span className="truncate">Search people for “{q}”</span>
            </Command.Item>
          </Command.Group>
        ) : null}

        <Command.Group heading="Go to">
          {NAV.map((item) => {
            const Icon = ICONS[item.key];
            return (
              <Command.Item
                key={item.key}
                value={`go ${item.label}`}
                keywords={KEYWORDS[item.key]}
                onSelect={() => go(item.href)}
                className={ITEM}
              >
                <Icon size={16} aria-hidden className="shrink-0 text-shell-muted" />
                {item.label}
              </Command.Item>
            );
          })}
        </Command.Group>

        {launches.length || archivedLaunches.length ? (
          <Command.Group heading="Launches">
            {[...launches, ...archivedLaunches].map((l) => {
              const archived = archivedLaunches.includes(l);
              const Icon = archived ? Archive : Rocket;
              return (
                <Command.Item
                  key={l.id}
                  value={`launch ${l.name} ${l.id}`}
                  keywords={["launch", "waitlist"]}
                  onSelect={() => go(`/admin/launches/${l.id}`)}
                  className={ITEM}
                >
                  <Icon size={16} aria-hidden className="shrink-0 text-shell-muted" />
                  <span className="truncate">{l.name}</span>
                  {archived ? <span className="ml-auto text-xs text-shell-faint">Archived</span> : null}
                </Command.Item>
              );
            })}
          </Command.Group>
        ) : null}

        {workspaces.length ? (
          <Command.Group heading="Content">
            {workspaces.map((w) => (
              <Command.Item
                key={w.id}
                value={`content ${w.name} ${w.id}`}
                keywords={["workspace", "content"]}
                onSelect={() => go(`/admin/workspace/${w.id}`)}
                className={ITEM}
              >
                <PenLine size={16} aria-hidden className="shrink-0 text-shell-muted" />
                <span className="truncate">{w.name}</span>
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}

        {lists?.journeys.length ? (
          <Command.Group heading="Journeys">
            {lists.journeys.map((j) => (
              <Command.Item
                key={j.id}
                value={`journey ${j.name} ${j.id}`}
                keywords={["journey", "lifecycle"]}
                onSelect={() => go(`/admin/lifecycle/${j.id}`)}
                className={ITEM}
              >
                <Route size={16} aria-hidden className="shrink-0 text-shell-muted" />
                <span className="truncate">{j.name}</span>
                {j.connectionName ? <span className="ml-auto truncate text-xs text-shell-faint">{j.connectionName}</span> : null}
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}

        {lists?.products.length ? (
          <Command.Group heading="Products">
            {lists.products.map((p) => (
              <Command.Item
                key={p.id}
                value={`product ${p.name} ${p.id}`}
                keywords={["product", "connection"]}
                onSelect={() => go(`/admin/products/${p.id}`)}
                className={ITEM}
              >
                <Box size={16} aria-hidden className="shrink-0 text-shell-muted" />
                <span className="truncate">{p.name}</span>
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}

        <Command.Group heading="Create">
          <Command.Item value="create new launch" onSelect={() => go("/admin/launches/new")} className={ITEM}>
            <Plus size={16} aria-hidden className="shrink-0 text-shell-muted" />
            New launch
          </Command.Item>
          <Command.Item
            value={PHASE3 ? "create new content programme workspace" : "create new content workspace"}
            onSelect={() => go("/admin/workspace")}
            className={ITEM}
          >
            <Plus size={16} aria-hidden className="shrink-0 text-shell-muted" />
            {PHASE3 ? "New programme" : "New content workspace"}
          </Command.Item>
          {lifecycle ? (
            <Command.Item value="create new journey" onSelect={() => go("/admin/lifecycle")} className={ITEM}>
              <Plus size={16} aria-hidden className="shrink-0 text-shell-muted" />
              New journey
            </Command.Item>
          ) : null}
        </Command.Group>
      </Command.List>
    </Command.Dialog>
  );
}

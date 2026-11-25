"use client";

import { useId } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronRight, CircleDashed, type LucideIcon } from "lucide-react";
import type { RevealKey } from "@/lib/nav/reveal";
import { COMING_UP_WORDS } from "@/lib/onboarding/words";
import { useThemePortalContainer } from "./AdminThemeRoot";

export interface ComingUpItem {
  key: RevealKey;
  /** buildNav's label, so People and Ideas words follow. */
  label: string;
  href: string;
  icon: LucideIcon;
  /** When it comes in, in the founder's terms (src/lib/onboarding/sidebarFit.ts). */
  why: string;
}

/**
 * The sidebar's Coming up row and its menu (ONBOARDING_ENABLED): the sections still waiting for
 * this brand, each with its line, and Open early. The nav scrolls, so the menu is portalled into
 * the themed shell (as ProfileMenu's is) rather than drawn beside the row. Collapsed, the row is
 * its icon only and opens the same menu.
 */
export function ComingUp({
  items,
  collapsed,
  mod,
  rowClassName,
  onOpen,
}: {
  items: ComingUpItem[];
  collapsed: boolean;
  /** "⌘" on a Mac, "Ctrl " elsewhere (SidebarV2's). */
  mod: string;
  rowClassName: string;
  onOpen: (item: ComingUpItem) => void;
}) {
  const container = useThemePortalContainer();
  const titleId = useId();
  return (
    <div className="space-y-0.5">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          aria-label={COMING_UP_WORDS.rowAria(items.length)}
          title={collapsed ? COMING_UP_WORDS.title : undefined}
          className={`${rowClassName} outline-none focus-visible:ring-2 focus-visible:ring-blue-500 data-[state=open]:bg-shell-active data-[state=open]:text-shell-ink`}
        >
          <CircleDashed size={18} aria-hidden className="shrink-0" />
          {!collapsed && (
            <>
              <span className="flex-1 truncate">{COMING_UP_WORDS.title}</span>
              <span className="text-xs tabular-nums text-shell-faint">{items.length}</span>
              <ChevronRight size={14} aria-hidden className="shrink-0 text-shell-faint" />
            </>
          )}
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal container={container}>
          <DropdownMenu.Content
            side="right"
            align="start"
            sideOffset={8}
            collisionPadding={8}
            aria-labelledby={titleId}
            className="z-50 w-[392px] max-w-[calc(100vw-16px)] rounded-lg border border-shell-line bg-shell-raised p-1 text-sm text-shell-ink shadow-lg"
          >
            <div className="px-2.5 pb-1.5 pt-2">
              <p id={titleId} className="font-semibold">
                {COMING_UP_WORDS.title}
              </p>
              <p className="mt-0.5 text-xs text-shell-muted">{COMING_UP_WORDS.sub}</p>
            </div>
            {items.map((item) => {
              const Icon = item.icon;
              return (
                <DropdownMenu.Item
                  key={item.key}
                  aria-label={COMING_UP_WORDS.itemAria(item.label, item.why)}
                  onSelect={() => onOpen(item)}
                  className="group flex cursor-pointer select-none items-center gap-2.5 rounded-md px-2.5 py-2 outline-none data-[highlighted]:bg-shell-active"
                >
                  <span
                    aria-hidden
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-dashed border-shell-faint text-shell-muted"
                  >
                    <Icon size={16} />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="font-medium">{item.label}</span>
                    <span className="text-xs text-shell-muted">{item.why}</span>
                  </span>
                  <span
                    aria-hidden
                    className="shrink-0 rounded-md border border-shell-line px-2 py-0.5 text-xs font-medium text-shell-ink group-data-[highlighted]:border-shell-ink"
                  >
                    {COMING_UP_WORDS.openEarly}
                  </span>
                </DropdownMenu.Item>
              );
            })}
            <DropdownMenu.Separator className="my-1 h-px bg-shell-line" />
            <p className="flex items-center gap-1.5 px-2.5 pb-1.5 pt-1 text-xs text-shell-muted">
              <kbd className="rounded border border-shell-line px-1 font-mono text-[10.5px] text-shell-faint">{`${mod}K`}</kbd>
              {COMING_UP_WORDS.foot}
            </p>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}

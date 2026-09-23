"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { breadcrumbsFor, type CrumbNames } from "@/lib/nav/model";
import { launchInView, vizzyPageLabel } from "@/lib/nav/vizzy";
import { useDashboardChat, type UseDashboardChatReturn } from "../chat/useDashboardChat";

interface Shell {
  /** The one Vizzy conversation, shared by Home and the Ask Vizzy panel. */
  chat: UseDashboardChatReturn;
  /** Where the admin is, as sent to Vizzy, e.g. "Launches › Beta › Signups". */
  page: string;
  vizzyOpen: boolean;
  setVizzyOpen: (open: boolean) => void;
  toggleVizzy: () => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  /** Ask Vizzy from anywhere (⌘K, suggestions): opens the panel, or uses Home's chat. */
  ask: (text: string) => void;
}

const ShellContext = createContext<Shell | null>(null);

/** The nav v2 phase 2 shell, or null outside it (the chat then runs on its own). */
export function useShell(): Shell | null {
  return useContext(ShellContext);
}

/** On Home, Vizzy is the page itself, so the side panel stays closed there. */
export function isHome(pathname: string): boolean {
  return pathname === "/admin";
}

function focusHomeChat() {
  document.querySelector<HTMLTextAreaElement>("[data-vizzy-input]")?.focus();
}

/**
 * Nav v2 phase 2: holds Vizzy's conversation across pages (the layout persists
 * while the page changes), the panel and ⌘K state, and the two shortcuts. The
 * layout keys it by brand, so switching brand starts a fresh conversation.
 */
export function ShellProvider({ names, children }: { names: CrumbNames; children: ReactNode }) {
  const pathname = usePathname() ?? "/admin";
  const page = vizzyPageLabel(breadcrumbsFor(pathname, names));
  const chat = useDashboardChat({ context: { page, campaignId: launchInView(pathname) } });
  const [vizzyOpen, setVizzyOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { sendMessage } = chat;

  const toggleVizzy = useCallback(() => {
    if (isHome(pathname)) focusHomeChat();
    else setVizzyOpen((open) => !open);
  }, [pathname]);

  const ask = useCallback(
    (text: string) => {
      if (!isHome(pathname)) setVizzyOpen(true);
      void sendMessage(text);
    },
    [pathname, sendMessage],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const key = e.key.toLowerCase();
      // Ctrl+K / Ctrl+J are browser shortcuts on Windows and Linux: take them over.
      if (key === "k") {
        e.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (key === "j") {
        e.preventDefault();
        toggleVizzy();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleVizzy]);

  const value = useMemo<Shell>(
    () => ({ chat, page, vizzyOpen, setVizzyOpen, toggleVizzy, paletteOpen, setPaletteOpen, ask }),
    [chat, page, vizzyOpen, toggleVizzy, paletteOpen, ask],
  );
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

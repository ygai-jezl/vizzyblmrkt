"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { isInsightsHubEnabled, isNavV2Phase3Enabled, isNavV2Phase4Enabled } from "@/lib/nav/flags";
import { breadcrumbsFor, type CrumbNames } from "@/lib/nav/model";
import { isPlansUiEnabled } from "@/lib/plans/flags";
import { shellChatContext, vizzyPageLabel } from "@/lib/nav/vizzy";
import { useDashboardChat, type CanvasCardData, type UseDashboardChatReturn } from "../chat/useDashboardChat";
import { cardListeners } from "../chat/cardData";

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
  /** Vizzy can read the product user whose page is in view (LIFECYCLE_PERSON_BRIEF). */
  personInContext: boolean;
  /** Audience is called People (isPeopleNameEnabled(), from the server), so the How to drawer says what the sidebar says. */
  people: boolean;
  /** Fields on people and companies are on (isFieldsEnabled(), from the server), so the How to drawer shows their help. */
  fields: boolean;
  /** People can be filtered by fields (isFieldFiltersEnabled(), from the server), for the How to drawer. */
  fieldFilters: boolean;
  /** Admins can add someone by hand (isAddPersonEnabled(), from the server), for the How to drawer. */
  addPerson: boolean;
  /**
   * Hear about each draft Vizzy saves in this chat (returns the unsubscribe), so a page whose
   * data isn't the server's render (the journey editor, a person's page) can reload it. Null
   * unless the layout passes `journeyInContext` or `personInContext`.
   */
  onCanvasSaved: ((listener: (card: CanvasCardData) => void) => () => void) | null;
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
 *
 * With `journeyInContext` (journey styles on and an admin, from the server), the chat also names
 * the lifecycle journey in view, and pages can hear about the drafts Vizzy saves (onCanvasSaved).
 */
export function ShellProvider({
  names,
  journeyInContext = false,
  personInContext = false,
  people = false,
  fields = false,
  fieldFilters = false,
  addPerson = false,
  children,
}: {
  names: CrumbNames;
  journeyInContext?: boolean;
  /** Vizzy can read one person (LIFECYCLE_PERSON_BRIEF, from the server): the chat names the person in view. */
  personInContext?: boolean;
  /** Audience is called People (isPeopleNameEnabled(), from the server): the page label Vizzy gets follows the crumbs. */
  people?: boolean;
  /** Fields are on (isFieldsEnabled(), from the server): the How to drawer shows their help sections. */
  fields?: boolean;
  /** Field filters are on (isFieldFiltersEnabled(), from the server): the How to drawer shows their help. */
  fieldFilters?: boolean;
  /** New person is on (isAddPersonEnabled(), from the server): the How to drawer shows its help. */
  addPerson?: boolean;
  children: ReactNode;
}) {
  const pathname = usePathname() ?? "/admin";
  const page = vizzyPageLabel(breadcrumbsFor(pathname, names, { phase3: isNavV2Phase3Enabled(), insights: isInsightsHubEnabled(), plans: isPlansUiEnabled(), people }));
  const router = useRouter();
  // Made once, so a page's subscription outlives re-renders.
  const [saved] = useState(cardListeners);
  const chat = useDashboardChat({
    // The page, the launch in view, the programme / plan (nav v2 phase 4) and, with
    // journeyInContext, the lifecycle journey in view, for Vizzy's tools.
    context: shellChatContext(pathname, page, { phase4: isNavV2Phase4Enabled(), journeyInContext, personInContext }),
    // When Vizzy saves a draft of the page you're on, show its version.
    onCanvasSaved: (card) => {
      if (card.url.split("?")[0] === pathname) router.refresh();
      if (journeyInContext || personInContext) saved.emit(card);
    },
  });
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
    () => ({
      chat,
      page,
      vizzyOpen,
      setVizzyOpen,
      toggleVizzy,
      paletteOpen,
      setPaletteOpen,
      ask,
      personInContext,
      people,
      fields,
      fieldFilters,
      addPerson,
      onCanvasSaved: journeyInContext || personInContext ? saved.add : null,
    }),
    [chat, page, vizzyOpen, toggleVizzy, paletteOpen, ask, journeyInContext, personInContext, people, fields, fieldFilters, addPerson, saved],
  );
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

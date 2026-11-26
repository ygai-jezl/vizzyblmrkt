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
  /** Vizzy is told whose page is in view: it can read their situation or their fields (from the server). */
  personInContext: boolean;
  /** Vizzy can read the situation of the person in view (LIFECYCLE_PERSON_BRIEF); without it, only their fields. */
  personBrief: boolean;
  /** Audience is called People (isPeopleNameEnabled(), from the server), so the How to drawer says what the sidebar says. */
  people: boolean;
  /** Fields on people and companies are on (isFieldsEnabled(), from the server), so the How to drawer shows their help. */
  fields: boolean;
  /** People can be filtered by fields (isFieldFiltersEnabled(), from the server), for the How to drawer. */
  fieldFilters: boolean;
  /** Admins can add someone by hand (isAddPersonEnabled(), from the server), for the How to drawer. */
  addPerson: boolean;
  /** A person's page has a timeline (isTimelineEnabled(), from the server), for the How to drawer. */
  timeline: boolean;
  /** Vizzy reads people's fields and suggests changes (isVizzyFieldsEnabled(), from the server), for the How to drawer. */
  vizzyFields: boolean;
  /** Vizzy also reads text fields an admin let it read (isVizzyTextFieldsEnabled(), from the server), for the How to drawer. */
  vizzyTextFields: boolean;
  /** Vizzy fills in the New person form (isVizzyAddPersonEnabled(), from the server), for the How to drawer. */
  vizzyAddPerson: boolean;
  /** Every catalog save is kept as history (isCatalogHistoryEnabled(), from the server), for the How to drawer. */
  catalogHistory: boolean;
  /** Vizzy reads connected data (isConnectorsChatEnabled(), from the server), for the How to drawer. */
  connectorsChat: boolean;
  /** Connected data is collected daily (isConnectorsCollectEnabled(), from the server), for the How to drawer. */
  connectorsCollect: boolean;
  /** Search Console's searches are in brand search (isConnectorsSearchTextEnabled(), from the server), for the How to drawer. */
  connectorsSearchText: boolean;
  /** Collected numbers suggest what to write (isConnectorSignalsEnabled(), from the server), for the How to drawer. */
  connectorSignals: boolean;
  /** Next up weighs AI answers (isAiAnswersPlanningEnabled(), from the server), for the How to drawer. */
  aiAnswers: boolean;
  /** The brand map is kept at any size (isBrandMapScaleEnabled(), from the server), for the How to drawer. */
  brandMapScale: boolean;
  /** Launches are ideas (isIdeasEnabled(), from the server), for the How to drawer. */
  ideas: boolean;
  /**
   * Launches are called Ideas (isIdeaWordsEnabled(), from the server): the page label Vizzy gets
   * follows the crumbs, the Ask Vizzy panel's starters say idea, and so does the How to drawer.
   */
  ideaWords: boolean;
  /** Organisations share connections (isConnectorsSharingEnabled(), from the server), for the How to drawer. */
  sharing: boolean;
  /** Owners bring in and move out brands (isOrganisationJoinEnabled(), from the server), for the How to drawer. */
  join: boolean;
  /** Vizzy gets to know a new brand on the welcome (isOnboardingEnabled(), from the server), for the How to drawer. */
  onboarding: boolean;
  /** Talk with Vizzy by voice on the welcome (isOnboardingVoiceEnabled(), from the server), for the How to drawer. */
  onboardingVoice: boolean;
  /** Home's Your next action is a card Vizzy writes (isNextActionCardEnabled(), from the server), for the How to drawer. */
  nextActionCard: boolean;
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
  personBrief = false,
  people = false,
  fields = false,
  fieldFilters = false,
  addPerson = false,
  timeline = false,
  vizzyFields = false,
  vizzyTextFields = false,
  vizzyAddPerson = false,
  catalogHistory = false,
  connectorsChat = false,
  connectorsCollect = false,
  connectorsSearchText = false,
  connectorSignals = false,
  aiAnswers = false,
  brandMapScale = false,
  ideas = false,
  ideaWords = false,
  sharing = false,
  join = false,
  onboarding = false,
  onboardingVoice = false,
  nextActionCard = false,
  children,
}: {
  names: CrumbNames;
  journeyInContext?: boolean;
  /**
   * Vizzy can read one person's situation (LIFECYCLE_PERSON_BRIEF) or their fields
   * (AUDIENCE_VIZZY_FIELDS_ENABLED), from the server: the chat names the person in view.
   */
  personInContext?: boolean;
  /** The brief is on (isPersonBriefEnabled(), from the server): the panel offers the situation's starters. */
  personBrief?: boolean;
  /** Audience is called People (isPeopleNameEnabled(), from the server): the page label Vizzy gets follows the crumbs. */
  people?: boolean;
  /** Fields are on (isFieldsEnabled(), from the server): the How to drawer shows their help sections. */
  fields?: boolean;
  /** Field filters are on (isFieldFiltersEnabled(), from the server): the How to drawer shows their help. */
  fieldFilters?: boolean;
  /** New person is on (isAddPersonEnabled(), from the server): the How to drawer shows its help. */
  addPerson?: boolean;
  /** The timeline is on (isTimelineEnabled(), from the server): the How to drawer shows its help. */
  timeline?: boolean;
  /** Vizzy's field suggestions are on (isVizzyFieldsEnabled(), from the server): the How to drawer shows their help. */
  vizzyFields?: boolean;
  /** Vizzy's text fields are on (isVizzyTextFieldsEnabled(), from the server): the How to drawer explains the opt-in. */
  vizzyTextFields?: boolean;
  /** Vizzy's New person drafts are on (isVizzyAddPersonEnabled(), from the server): the How to drawer shows their help. */
  vizzyAddPerson?: boolean;
  /** Catalog history is on (isCatalogHistoryEnabled(), from the server): the How to drawer shows its help. */
  catalogHistory?: boolean;
  /** Vizzy reads connected data (isConnectorsChatEnabled(), from the server): the How to drawer says so. */
  connectorsChat?: boolean;
  /** Connected data is collected daily (isConnectorsCollectEnabled(), from the server): the How to drawer says so. */
  connectorsCollect?: boolean;
  /** Search Console's searches are in brand search (isConnectorsSearchTextEnabled(), from the server): the How to drawer says so. */
  connectorsSearchText?: boolean;
  /** Collected numbers suggest what to write (isConnectorSignalsEnabled(), from the server): the How to drawer says so. */
  connectorSignals?: boolean;
  /** Next up weighs AI answers (isAiAnswersPlanningEnabled(), from the server): the How to drawer says so. */
  aiAnswers?: boolean;
  /** The brand map is kept at any size (isBrandMapScaleEnabled(), from the server): the How to drawer says where proposals wait. */
  brandMapScale?: boolean;
  /** Launches are ideas (isIdeasEnabled(), from the server): the How to drawer shows their help sections. */
  ideas?: boolean;
  /** Launches are called Ideas (isIdeaWordsEnabled(), from the server): the page label Vizzy gets follows the crumbs. */
  ideaWords?: boolean;
  /** Organisations share connections (isConnectorsSharingEnabled(), from the server): the How to drawer says so. */
  sharing?: boolean;
  /** Owners bring in and move out brands (isOrganisationJoinEnabled(), from the server): the How to drawer says so. */
  join?: boolean;
  /** Vizzy gets to know a new brand on the welcome (isOnboardingEnabled(), from the server): the How to drawer says so. */
  onboarding?: boolean;
  /** Talk with Vizzy by voice on the welcome (isOnboardingVoiceEnabled(), from the server): the How to drawer says so. */
  onboardingVoice?: boolean;
  /** Home's Your next action is a card Vizzy writes (isNextActionCardEnabled(), from the server): the How to drawer says so. */
  nextActionCard?: boolean;
  children: ReactNode;
}) {
  const pathname = usePathname() ?? "/admin";
  const page = vizzyPageLabel(
    breadcrumbsFor(pathname, names, {
      phase3: isNavV2Phase3Enabled(),
      insights: isInsightsHubEnabled(),
      plans: isPlansUiEnabled(),
      people,
      ideas: ideaWords,
    }),
  );
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
      personBrief,
      people,
      fields,
      fieldFilters,
      addPerson,
      timeline,
      vizzyFields,
      vizzyTextFields,
      vizzyAddPerson,
      catalogHistory,
      connectorsChat,
      connectorsCollect,
      connectorsSearchText,
      connectorSignals,
      aiAnswers,
      brandMapScale,
      ideas,
      ideaWords,
      sharing,
      join,
      onboarding,
      onboardingVoice,
      nextActionCard,
      onCanvasSaved: journeyInContext || personInContext ? saved.add : null,
    }),
    [chat, page, vizzyOpen, toggleVizzy, paletteOpen, ask, journeyInContext, personInContext, personBrief, people, fields, fieldFilters, addPerson, timeline, vizzyFields, vizzyTextFields, vizzyAddPerson, catalogHistory, connectorsChat, connectorsCollect, connectorsSearchText, connectorSignals, aiAnswers, brandMapScale, ideas, ideaWords, sharing, join, onboarding, onboardingVoice, nextActionCard, saved],
  );
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

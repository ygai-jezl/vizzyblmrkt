import type { BlogBrief } from "@/lib/types/contentPlan";
import type { ArticleMap } from "@/lib/content/blog/articleMap";
import type { AddressSaved } from "@/lib/content/blog/address";
import type { LiveAction, LiveCheck } from "@/lib/content/blog/live";
import type { FormatInputs, ImageFormatId } from "@/lib/types/imageStyle";
import type { SeenAnswers } from "./useSeenAnswers";

/** What a Make again asks for: this article's own style ("brand" = the brand's), a format and its words. */
export interface HeroMakeOptions {
  styleId?: string;
  format?: ImageFormatId;
  formatInputs?: FormatInputs;
}

/** How a live check, or a person's word on it, went. */
export type LiveResult = { ok: true; check: LiveCheck | null } | { ok: false; error: string };

/**
 * What the canvas hands the inspector for a blog hub written to the CITABLE structure:
 * the plan's brief (the canvas owns it and saves it with the plan), and the two actions
 * that run on the server — research, and the fact check.
 */
export interface BlogHubControls {
  brief: BlogBrief;
  onBriefChange: (next: BlogBrief) => void;
  /** Research the brief: the questions buyers ask, pages to link to, sources to cite. */
  onResearch: () => void;
  /** Check the copy's claims against the brand's own material and the checked sources. */
  onCheckFacts: () => void;
  /** What is running now, if anything. */
  busy: null | "research" | "check" | "seen";
  /** One line on how the last research or check went ("Found 6 questions…"), or what went wrong. */
  note: string | null;
  /** Which action the note is about, so it is shown beside that action's button. */
  noteFor: "research" | "check";
  /** The article's own URL (the plan's hub URL), when the operator has set one. */
  pageUrl: string | null;
  /** The programme's name — the publisher when the brief names none. */
  brandName: string;
  /** Absolute URL of the brand's primary logo, or null. */
  logoUrl: string | null;
  /**
   * Keep a source on the brief as one of the brand's cite sources, so every later
   * article can draw on it (it is added to the programme's knowledge, read as one page).
   * Left out while cite sources are off — and then nothing offers to.
   */
  onKeepSource?: (url: string) => Promise<"kept" | "failed">;
  /** The brand map the article is written from (its switch on and a map saved); absent = none. */
  map?: ArticleMap | null;
  /** Set the article's address (the plan's hub URL; null clears it). Left out while the brand
   *  map's pages switch is off, and then the address cannot be changed here. */
  onSetAddress?: (url: string | null) => Promise<AddressSaved>;
  /** Look again for the brand's notes that fit the article (What we've seen). Left out while
   *  BRAND_NOTES_ENABLED or the editorial writer is off, and then the box isn't shown. */
  onFindSeen?: () => void;
  /** Answers to the article's questions for its team, each saved as it is typed
   *  (BRAND_NOTES_QUESTIONS_ENABLED). Left out while that is off, and then the questions share
   *  one box, saved with the plan. */
  answers?: SeenAnswers;
  /** Articles are written in the editorial shape (CREATE_BLOG_EDITORIAL_ENABLED): the author's role and bio can be set. */
  editorial?: boolean;
  /** Check, mark or clear that the article is live at its address. Present with onSetAddress. */
  onLive?: (nodeId: string, action: LiveAction) => Promise<LiveResult>;
  /** The hero image (BLOG_HERO_ENABLED); absent = no hero card. */
  hero?: BlogHeroControls;
}

/** The hero card's actions. Each resolves to a line saying what went wrong, or null. */
export interface BlogHeroControls {
  /** Make (or make again) the hero, in this article's own style or format when asked. */
  make: (nodeId: string, opts?: HeroMakeOptions) => Promise<string | null>;
  upload: (nodeId: string, file: File) => Promise<string | null>;
  setAlt: (nodeId: string, alt: string) => Promise<string | null>;
  /** The article whose hero is being made now, if any. */
  busyId: string | null;
  /** A stored file's address (the workspace's private asset proxy). */
  assetUrl: (ref: string) => string;
}

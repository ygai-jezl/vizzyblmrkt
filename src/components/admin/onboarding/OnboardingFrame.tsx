"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { BrandFavicon } from "@/components/admin/BrandFavicon";
import type { ProfileAnswers } from "@/lib/types/businessProfile";
import { FRAME_WORDS } from "@/lib/onboarding/words";

/** What the welcome's layout read once on the server, for every screen under it. */
export interface OnboardingInfo {
  brand: { name: string; faviconUrl?: string };
  /** Talk with Vizzy is offered: the voice switch, the Live API and this brand's grant. */
  voice: boolean;
  /** The answers saved so far, when the layout rendered. */
  answers: ProfileAnswers;
}

const OnboardingContext = createContext<OnboardingInfo | null>(null);

/** The top bar's right side, where a call shows Live and its time left (see useFrameTopSlot). */
const TopSlotContext = createContext<HTMLElement | null>(null);

/** The element on the right of the top bar, for a portal, or null until it is there. */
export function useFrameTopSlot(): HTMLElement | null {
  return useContext(TopSlotContext);
}

/** The welcome's brand, voice and saved answers. Only inside OnboardingFrame. */
export function useOnboarding(): OnboardingInfo {
  const info = useContext(OnboardingContext);
  if (!info) throw new Error("useOnboarding is only for the screens under /admin/welcome");
  return info;
}

/**
 * The getting to know you pages at /admin/welcome: full screen over the admin shell (sidebar,
 * header, Vizzy and the How to drawer), as the eBook studio and Edit mode sit above it. The brand
 * sits top left. It keeps the shell's theme, its session prompt and ⌘K, which stays a way out.
 */
export function OnboardingFrame({ children, ...info }: OnboardingInfo & { children?: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const [topSlot, setTopSlot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    // Screen readers start here, unless a screen already moved focus to its heading.
    const el = root.current;
    if (el && !el.contains(document.activeElement)) el.focus();
  }, []);

  return (
    <OnboardingContext.Provider value={info}>
      <TopSlotContext.Provider value={topSlot}>
        <div
          ref={root}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label={FRAME_WORDS.label}
          className="fixed inset-0 z-40 flex flex-col overflow-y-auto overscroll-contain bg-shell-page text-shell-ink outline-none"
          style={{
            backgroundImage:
              "radial-gradient(ellipse 70% 42% at 50% 0%, color-mix(in srgb, var(--yg-accent) 11%, transparent), transparent 72%)",
          }}
        >
          <header className="flex h-14 shrink-0 items-center justify-between gap-4 px-6">
            <span className="flex min-w-0 items-center gap-2 text-sm font-semibold">
              <BrandFavicon name={info.brand.name} faviconUrl={info.brand.faviconUrl} size={20} />
              <span className="truncate">{info.brand.name}</span>
            </span>
            <div ref={setTopSlot} className="flex shrink-0 items-center gap-4 text-[13px] leading-[18px] text-shell-muted" />
          </header>
          <div className="relative flex flex-1 flex-col items-center justify-center px-4 pb-20 pt-6 sm:px-6">{children}</div>
        </div>
      </TopSlotContext.Provider>
    </OnboardingContext.Provider>
  );
}

export type OrbLook = "start" | "wait" | "live" | "done";

const CORE: Record<OrbLook, string> = {
  start: "bg-shell-accent text-white shadow-[0_0_0_8px_var(--yg-accent-soft),0_14px_32px_-10px_var(--yg-accent)]",
  wait: "border-2 border-shell-accent bg-shell-card text-shell-accent shadow-[0_0_0_8px_var(--yg-accent-soft),0_14px_32px_-10px_var(--yg-accent)]",
  live: "bg-shell-accent text-white shadow-[0_0_0_8px_var(--yg-accent-soft),0_14px_32px_-10px_var(--yg-accent)]",
  done: "bg-shell-ink text-shell-side shadow-[0_0_0_8px_var(--yg-active)]",
};

/**
 * The rings and the round core above a screen's heading. `done` (or `look="done"`) is the
 * finished look, `wait` waits for the browser, `live` breathes while Vizzy listens (still under
 * reduced motion). `small` is the call's size.
 */
export function Orb({ done = false, look, small = false, children }: { done?: boolean; look?: OrbLook; small?: boolean; children: ReactNode }) {
  const as: OrbLook = look ?? (done ? "done" : "start");
  const ring = `absolute rounded-full border ${as === "done" ? "border-shell-faint" : "border-shell-accent"}${as === "live" ? " yg-breathe" : ""}`;
  const step = small ? 14 : 18;
  return (
    <div aria-hidden className={`relative grid shrink-0 place-items-center ${small ? "h-32 w-32" : "h-[168px] w-[168px]"}`}>
      <span className={ring} style={{ inset: 0, opacity: 0.14 }} />
      <span className={ring} style={{ inset: step, opacity: 0.24, animationDelay: "0.3s" }} />
      <span className={ring} style={{ inset: step * 2, opacity: 0.42, animationDelay: "0.6s" }} />
      <span className={`relative grid h-16 w-16 place-items-center rounded-full ${CORE[as]}`}>{children}</span>
    </div>
  );
}

/** Save to the brand's profile. True when it saved. */
export async function saveProfile(body: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch("/api/admin/onboarding/profile", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

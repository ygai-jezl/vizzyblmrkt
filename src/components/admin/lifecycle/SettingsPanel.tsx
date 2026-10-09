"use client";

import { useEffect, useId, useMemo, useState } from "react";
import Link from "next/link";
import { startsAfterJourney, startsOnDate, type LifecycleSettings } from "@/lib/types/lifecycle";
import type { ConnectionCatalog } from "@/lib/types/productConnection";
import { HEADER_TEXT_CHOICES, type HeaderTextChoice, type JourneyEmailStyle, type StoredJourneyStyle } from "@/lib/types/tenant";
import { BRAND_KIT_EMAIL_STYLE_ROUTE } from "@/lib/content/brandKit";
import { normalizeHex } from "@/lib/content/create/colorPalette";
import type { ResolvedEmailStyle } from "@/lib/email/emailStyle";
import { averageInk, type PaletteChip } from "../brand-kit/emailStyleForm";
import { Badge, Field, Section, inputClass } from "../connect/ui";
import { AboutSection } from "./AboutSection";
import { ContinuesFromField } from "./JourneyLinks";
import { DateStartField } from "./DateStart";
import type { JourneyChain } from "./model";
import {
  customJourneyStyle,
  journeyBannerNote,
  journeyStyleHints,
  logoSamplePath,
  readJourneyStyle,
  withJourneyGradient,
  withJourneyHeaderText,
} from "./journeyStyleForm";

/**
 * Journey settings: what starts it, when emails may go out (in each person's own
 * timezone), who they come from, and the unsubscribe category. A launch's
 * welcome journey (`waitlist`, engine move) starts when someone joins, can send
 * at any time, has no end date by default, and sends from the launch's sender.
 * With journey styles on, either kind has an Email style section too: the
 * brand's Email style, or the journey's own header and button colours.
 */

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const RESERVED = ["user.signed_up", "onboarding.completed"];
/** Derived by YouGrow from the consent a product sends (LIFECYCLE_CONSENT_AT_SEND). */
const CONSENT_GRANTED = "user.marketing_consent_granted";

export function SettingsPanel({
  settings,
  catalog,
  sender,
  readOnly,
  onChange,
  waitlist = null,
  consentAtSend = false,
  optInAfterSignup = false,
  entities = false,
  emailStyleEnabled = false,
  journeyStyle = null,
  chain = null,
  dateStart = false,
  liveTracking = false,
}: {
  settings: LifecycleSettings;
  catalog: ConnectionCatalog | undefined;
  sender: { verified: boolean; fromEmail: string | null; fromName?: string | null };
  readOnly: boolean;
  onChange: (next: LifecycleSettings) => void;
  waitlist?: { launchId: string; launchName: string } | null;
  /** Consent decides marketing: the consent-only setting and the opt-in trigger. */
  consentAtSend?: boolean;
  /** The opt-in trigger fires only after the sign-up window (LIFECYCLE_OPT_IN_AFTER_SIGNUP). */
  optInAfterSignup?: boolean;
  /** API v2 entities (CONNECT_ENTITIES_ENABLED): the About setting and the `entity.created` trigger. */
  entities?: boolean;
  /** Links Sender to Brand › Email style (EMAIL_STYLE_ENABLED). */
  emailStyleEnabled?: boolean;
  /**
   * The journey's own Email style (EMAIL_JOURNEY_STYLE_ENABLED): an Email style section after
   * Sender, in place of the link. Null = the link, as before.
   */
  journeyStyle?: JourneyStyleControl | null;
  /** Journey links (LIFECYCLE_JOURNEY_LINKS_ENABLED): "Starts when" can name a journey to continue from. Null = off. */
  chain?: JourneyChain | null;
  /** "Starts when" can name a date fact and a number of days (LIFECYCLE_DATE_START). */
  dateStart?: boolean;
  /** A product journey's tracking reaches everyone in it once published (LIFECYCLE_SEND_TRACKING). */
  liveTracking?: boolean;
}) {
  const p = settings.sendPolicy;
  const continuing = Boolean(chain) && startsAfterJourney(settings);
  const onDate = dateStart && startsOnDate(settings);
  const setPolicy = (patch: Partial<LifecycleSettings["sendPolicy"]>) => onChange({ ...settings, sendPolicy: { ...p, ...patch } });
  const events = [
    ...new Set([
      ...RESERVED,
      ...(consentAtSend ? [CONSENT_GRANTED] : []),
      ...(entities && !waitlist ? ["entity.created"] : []),
      ...(catalog?.events ?? []).map((e) => e.name),
    ]),
  ];
  const entry = settings.entry ?? { requireMarketingConsent: false };
  const time = `${String(p.startHour).padStart(2, "0")}:${String(p.startMinute).padStart(2, "0")}`;
  const endMin = p.startHour * 60 + p.startMinute + p.windowMinutes;
  const tooLate = endMin > 24 * 60;

  if (waitlist) {
    return (
      <div className="space-y-4">
        <Section title="Starts when" description="Someone joins the waitlist and verifies their email. Each person enters once.">
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Everyone on {waitlist.launchName}&rsquo;s list who joins while this journey is live gets it — and anyone who joins while it&rsquo;s paused starts when you resume it.
          </p>
        </Section>
        <Section title="When emails go out" description="Welcome emails have always gone out as soon as each step is due.">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" disabled={readOnly} checked={Boolean(p.anytime)} onChange={(e) => setPolicy({ anytime: e.target.checked || undefined })} />
            Any time of day, any day
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              disabled={readOnly}
              checked={p.hardStopDays !== null}
              onChange={(e) => setPolicy({ hardStopDays: e.target.checked ? 60 : null })}
            />
            Stop after
            <input
              className={`${inputClass} w-20`}
              type="number"
              min={1}
              max={60}
              disabled={readOnly || p.hardStopDays === null}
              value={p.hardStopDays ?? ""}
              onChange={(e) => setPolicy({ hardStopDays: Math.min(60, Math.max(1, Number(e.target.value) || 1)) })}
            />
            days
          </label>
        </Section>
        <Section title="Sender" description="Welcome emails come from the launch's sender, set in the launch's settings (or your Domains settings).">
          <p className="text-sm">
            {sender.fromName ?? "Your brand"} {sender.fromEmail ? <span className="text-neutral-500">&lt;{sender.fromEmail}&gt;</span> : <span className="text-neutral-500">(the default address)</span>}
          </p>
          {emailStyleEnabled && !journeyStyle ? <EmailStyleLink /> : null}
        </Section>
        {journeyStyle ? <JourneyStyleSection value={settings.emailStyle} readOnly={readOnly} {...journeyStyle} /> : null}
        <Section title="Tracking" description="On for welcome emails, as it has always been, so opens and clicks show in the launch's analytics.">
          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" disabled={readOnly} checked={settings.tracking.opens} onChange={(e) => onChange({ ...settings, tracking: { ...settings.tracking, opens: e.target.checked } })} />
              Track opens
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" disabled={readOnly} checked={settings.tracking.clicks} onChange={(e) => onChange({ ...settings, tracking: { ...settings.tracking, clicks: e.target.checked } })} />
              Track clicks
            </label>
          </div>
        </Section>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Section
        title="Starts when"
        description={
          onDate
            ? "A date passing enrols someone, once a day."
            : chain
              ? `Which product event enrols someone — or the journey they finish first${dateStart ? ", or a date passing" : ""}. Each person enters once.`
              : `Which product event enrols someone${dateStart ? ", or a date passing" : ""}. Each person enters once.`
        }
      >
        {chain && !onDate ? <ContinuesFromField settings={settings} chain={chain} readOnly={readOnly} onChange={onChange} /> : null}
        {dateStart && !continuing ? <DateStartField settings={settings} catalog={catalog} readOnly={readOnly} onChange={onChange} /> : null}
        <div className={continuing || onDate ? "hidden" : "grid gap-3 sm:grid-cols-2"}>
          <Field
            label="Event"
            hint={
              settings.trigger.event !== CONSENT_GRANTED
                ? undefined
                : optInAfterSignup
                  ? "People who opt in after their sign-up window. Opt-ins during sign-up join your sign-up journeys instead."
                  : "People YouGrow already holds who opt in to marketing."
            }
          >
            <select
              className={inputClass}
              value={settings.trigger.event}
              disabled={readOnly}
              onChange={(e) => onChange({ ...settings, trigger: { ...settings.trigger, event: e.target.value } })}
            >
              {events.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Ignore events older than (hours)" hint="So a backfill of old sign-ups doesn't start the sequence.">
            <input
              className={inputClass}
              type="number"
              min={1}
              max={720}
              disabled={readOnly}
              value={settings.trigger.maxEventAgeHours}
              onChange={(e) => onChange({ ...settings, trigger: { ...settings.trigger, maxEventAgeHours: Math.min(720, Math.max(1, Number(e.target.value) || 1)) } })}
            />
          </Field>
        </div>
        {consentAtSend ? (
          <label className="mt-3 flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              disabled={readOnly}
              checked={entry.requireMarketingConsent}
              onChange={(e) => onChange({ ...settings, entry: { ...entry, requireMarketingConsent: e.target.checked } })}
            />
            <span>
              Only people with marketing consent
              <span className="block text-xs text-neutral-500">
                {continuing
                  ? "Uses the consent your product sends, as it stands when they finish the journey before."
                  : onDate
                    ? "Uses the consent your product sends, as it stands on the day they're checked."
                    : "Uses the consent your product sends. Someone who opts in while the event is still recent enough joins then, from the start."}
              </span>
            </span>
          </label>
        ) : null}
      </Section>

      {entities && !waitlist ? <AboutSection settings={settings} catalog={catalog} readOnly={readOnly} onChange={onChange} /> : null}

      <Section title="Send window" description="Emails only go out in this window, in each person's own timezone, at a steady minute that's theirs. Nothing is ever sent late.">
        <div className="flex flex-wrap gap-1.5">
          {DAYS.map((d, i) => (
            <label key={d} className="flex items-center gap-1 rounded-md border border-neutral-200 px-2 py-1 text-sm dark:border-neutral-800">
              <input
                type="checkbox"
                disabled={readOnly}
                checked={p.days.includes(i)}
                onChange={(e) => {
                  const days = e.target.checked ? [...p.days, i].sort() : p.days.filter((x) => x !== i);
                  if (days.length) setPolicy({ days });
                }}
              />
              {d}
            </label>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="From">
            <input
              className={inputClass}
              type="time"
              disabled={readOnly}
              value={time}
              onChange={(e) => {
                const [h, m] = e.target.value.split(":").map(Number);
                if (Number.isFinite(h) && Number.isFinite(m)) setPolicy({ startHour: h!, startMinute: m! });
              }}
            />
          </Field>
          <Field label="Window (minutes)">
            <input className={inputClass} type="number" min={15} max={720} disabled={readOnly} value={p.windowMinutes} onChange={(e) => setPolicy({ windowMinutes: Math.min(720, Math.max(15, Number(e.target.value) || 15)) })} />
          </Field>
          <Field label="Stop after (days)">
            <input className={inputClass} type="number" min={1} max={60} disabled={readOnly} value={p.hardStopDays ?? ""} onChange={(e) => setPolicy({ hardStopDays: Math.min(60, Math.max(1, Number(e.target.value) || 1)) })} />
          </Field>
          <Field label="Timezone if unknown">
            <input className={inputClass} disabled={readOnly} value={p.fallbackTimezone} onChange={(e) => setPolicy({ fallbackTimezone: e.target.value.slice(0, 64) })} />
          </Field>
        </div>
        {tooLate ? <p className="text-sm text-red-600">The window must end by midnight.</p> : null}
      </Section>

      <Section
        title="Sender"
        description={
          <>
            Blank fields use your Domains settings. Live sending needs the From address on a verified sending domain{" "}
            {sender.verified ? <Badge tone="green">verified: {sender.fromEmail}</Badge> : <Badge tone="amber">not verified</Badge>}
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="From name">
            <input className={inputClass} disabled={readOnly} value={settings.sender.fromName ?? ""} placeholder="Jez at Vizzybl" onChange={(e) => onChange({ ...settings, sender: { ...settings.sender, fromName: e.target.value || null } })} />
          </Field>
          <Field label="From address">
            <input className={inputClass} type="email" disabled={readOnly} value={settings.sender.fromEmail ?? ""} placeholder="jez@vizzybl.ai" onChange={(e) => onChange({ ...settings, sender: { ...settings.sender, fromEmail: e.target.value.trim() || null } })} />
          </Field>
          <Field label="Reply-to">
            <input className={inputClass} type="email" disabled={readOnly} value={settings.sender.replyTo ?? ""} onChange={(e) => onChange({ ...settings, sender: { ...settings.sender, replyTo: e.target.value.trim() || null } })} />
          </Field>
        </div>
        {emailStyleEnabled && !journeyStyle ? <EmailStyleLink /> : null}
      </Section>

      {journeyStyle ? <JourneyStyleSection value={settings.emailStyle} readOnly={readOnly} {...journeyStyle} /> : null}

      <Section title="Unsubscribe category" description="One-click unsubscribe stops this category only (the product is told, so it can mirror it). People can still opt out of everything.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name people see">
            <input className={inputClass} disabled={readOnly} value={settings.category.label} onChange={(e) => onChange({ ...settings, category: { ...settings.category, label: e.target.value.slice(0, 80) } })} />
          </Field>
          <Field label="Key sent to the product">
            <input
              className={`${inputClass} font-mono`}
              disabled={readOnly}
              value={settings.category.key}
              onChange={(e) => onChange({ ...settings, category: { ...settings.category, key: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 64) } })}
            />
          </Field>
        </div>
      </Section>

      <Section
        title="Tracking"
        description={
          liveTracking
            ? "Shows who opened and clicked, on each person's page and in Analytics. It adds a pixel and rewrites links, so switch it off for a plain, personal-style journey. A change reaches people already in the journey once you publish."
            : "Off by default: open and click tracking rewrites links and adds a pixel, which can hurt deliverability for personal-style emails."
        }
      >
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" disabled={readOnly} checked={settings.tracking.opens} onChange={(e) => onChange({ ...settings, tracking: { ...settings.tracking, opens: e.target.checked } })} />
            Track opens
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" disabled={readOnly} checked={settings.tracking.clicks} onChange={(e) => onChange({ ...settings, tracking: { ...settings.tracking, clicks: e.target.checked } })} />
            Track clicks
          </label>
        </div>
      </Section>
    </div>
  );
}

/** The logo and colours every branded email wears are set once, for the whole brand. */
function EmailStyleLink() {
  return (
    <p className="text-xs text-neutral-500">
      Your logo and colours are set in{" "}
      <Link href={BRAND_KIT_EMAIL_STYLE_ROUTE} className="underline underline-offset-2">
        Brand › Email style
      </Link>
      .
    </p>
  );
}

/** What the Email style section works from and reports to (JourneyEditor fills it in). */
export interface JourneyStyleControl {
  /** The brand's resolved Email style (null = none saved): Custom starts from it and keeps its logo and name. */
  brand: ResolvedEmailStyle | null;
  /** The brand's colours as quick picks. */
  palette: PaletteChip[];
  /** Gradient and Header text draw (EMAIL_HEADER_OPTIONS_ENABLED). */
  headerOptions: boolean;
  /** The draft's style differs from the one the journey's emails wear now. */
  changedSincePublish: boolean;
  /** A Custom style, or null for the brand's Email style. */
  onChange: (style: JourneyEmailStyle | null) => void;
}

const HEADER_TEXT_LABELS: Record<HeaderTextChoice, string> = { auto: "Auto", white: "White", black: "Black" };

/**
 * The journey's Email style: the brand's (linked), or Custom for this journey (header and button
 * colours, and with header options a gradient and the header text), on the colour header with the
 * brand's logo, name and theme. It's saved with the draft and goes live on Publish. Members see it
 * read-only. The hints are the Email style page's, with the brand's logo read from this site.
 */
function JourneyStyleSection({
  value,
  readOnly,
  brand,
  palette,
  headerOptions,
  changedSincePublish,
  onChange,
}: JourneyStyleControl & { value: unknown; readOnly: boolean }) {
  const name = useId();
  const style = useMemo(() => readJourneyStyle(value), [value]);
  // Custom's colours while Brand is picked, so picking Custom again gives them back.
  const [kept, setKept] = useState<StoredJourneyStyle | null>(null);
  const logoInk = useLogoInk(style ? logoSamplePath(brand?.logo?.url) : null);
  const hints = style ? journeyStyleHints(style, brand, { logoInk, headerOptions }) : [];
  const bannerNote = style ? journeyBannerNote(brand) : null;
  const radio = `flex items-center gap-2 text-sm ${readOnly ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`;

  return (
    <Section
      title="Email style"
      description="The header and button colours this journey's emails wear. Saved with the draft; Publish applies it to every email the journey sends from then on."
      actions={changedSincePublish ? <Badge tone="amber">changed since publish</Badge> : null}
    >
      <div className="space-y-1.5">
        <label className={radio}>
          <input
            type="radio"
            name={name}
            checked={!style}
            disabled={readOnly}
            onChange={() => {
              if (style) setKept(style);
              onChange(null);
            }}
          />
          Brand&rsquo;s Email style
        </label>
        <p className="pl-6 text-xs text-neutral-500">
          Set in{" "}
          <Link href={BRAND_KIT_EMAIL_STYLE_ROUTE} className="underline underline-offset-2">
            Brand › Email style
          </Link>
          , for all your branded emails.
        </p>
        <label className={radio}>
          <input
            type="radio"
            name={name}
            checked={Boolean(style)}
            disabled={readOnly}
            onChange={() => onChange(customJourneyStyle(kept, brand, headerOptions))}
          />
          Custom for this journey
        </label>
      </div>
      {style ? (
        <div className="space-y-3 border-l-2 border-neutral-200 pl-4 dark:border-neutral-800">
          <p className="text-xs text-neutral-500">
            Your logo, name and theme stay your brand&rsquo;s.{bannerNote ? ` ${bannerNote}` : ""}
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <ColourPick
              label="Header colour"
              value={style.headerColor}
              chips={palette}
              disabled={readOnly}
              onChange={(headerColor) => onChange({ ...style, headerColor })}
            />
            <ColourPick
              label="Button colour"
              value={style.accentColor}
              chips={palette}
              disabled={readOnly}
              onChange={(accentColor) => onChange({ ...style, accentColor })}
            />
          </div>
          {headerOptions ? (
            <div className="space-y-3">
              <label className={radio}>
                <input
                  type="checkbox"
                  checked={Boolean(style.headerGradientColor)}
                  disabled={readOnly}
                  onChange={(e) => onChange(withJourneyGradient(style, e.target.checked, palette))}
                />
                Gradient
              </label>
              {style.headerGradientColor ? (
                <ColourPick
                  label="Colour 2"
                  hint="Fades from the header colour (top left) to this one (bottom right). Outlook and Gmail on Android show the header colour alone."
                  value={style.headerGradientColor}
                  chips={palette}
                  disabled={readOnly}
                  onChange={(headerGradientColor) => onChange({ ...style, headerGradientColor })}
                />
              ) : null}
              <div className="space-y-1">
                <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">Header text</span>
                <div className="flex flex-wrap gap-4">
                  {HEADER_TEXT_CHOICES.map((choice) => (
                    <label key={choice} className={radio}>
                      <input
                        type="radio"
                        name={`${name}-text`}
                        checked={(style.headerText ?? "auto") === choice}
                        disabled={readOnly}
                        onChange={() => onChange(withJourneyHeaderText(style, choice))}
                      />
                      {HEADER_TEXT_LABELS[choice]}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          ) : null}
          {hints.length ? (
            <ul className="space-y-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
              {hints.map((h) => (
                <li key={h}>{h}.</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </Section>
  );
}

/**
 * The average colour of the logo at `path` (same-origin, so a canvas can read it) for the logo
 * contrast hint; null while it loads, or when it can't be read, which skips that hint.
 */
function useLogoInk(path: string | null): string | null {
  const [read, setRead] = useState<{ path: string; ink: string | null } | null>(null);
  useEffect(() => {
    if (!path) return;
    let live = true;
    const img = new Image();
    img.onload = () => {
      if (live) setRead({ path, ink: readInk(img) });
    };
    img.src = path;
    return () => {
      live = false;
    };
  }, [path]);
  return read && read.path === path ? read.ink : null;
}

/** One small (64px) read of a loaded logo; null if the canvas can't be read. */
function readInk(img: HTMLImageElement): string | null {
  try {
    const scale = Math.min(1, 64 / Math.max(img.naturalWidth, img.naturalHeight, 1));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext("2d");
    if (!g) return null;
    g.drawImage(img, 0, 0, w, h);
    return averageInk(g.getImageData(0, 0, w, h).data);
  } catch {
    return null; // a tainted or unsupported canvas: no hint, never an error
  }
}

const HEX_TYPED = /^#?[0-9a-f]{6}$/i;

/** A colour: its picker, its hex (kept as typed until it's a full #rrggbb) and the brand's colours as quick picks. */
function ColourPick({
  label,
  hint,
  value,
  chips,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  chips: PaletteChip[];
  disabled: boolean;
  onChange: (hex: string) => void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <div className="space-y-1.5">
      <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{label}</span>
      {hint ? <p className="text-xs text-neutral-500">{hint}</p> : null}
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value.toLowerCase())}
          className="h-8 w-10 shrink-0 cursor-pointer rounded border border-neutral-300 disabled:cursor-not-allowed disabled:opacity-60 dark:border-neutral-700"
          aria-label={`${label} picker`}
        />
        <input
          className={`${inputClass} w-28 font-mono`}
          value={text}
          maxLength={7}
          spellCheck={false}
          disabled={disabled}
          aria-label={`${label} hex code`}
          onChange={(e) => {
            setText(e.target.value);
            const hex = HEX_TYPED.test(e.target.value.trim()) ? normalizeHex(e.target.value) : null;
            if (hex) onChange(hex);
          }}
          onBlur={() => setText(value)}
        />
      </div>
      {chips.length ? (
        <div className="flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <button
              key={c.hex}
              type="button"
              disabled={disabled}
              title={c.name === c.hex ? c.hex : `${c.name} · ${c.hex}`}
              aria-label={c.name === c.hex ? `${label}: use ${c.hex}` : `${label}: use ${c.name} (${c.hex})`}
              aria-pressed={c.hex === value}
              onClick={() => onChange(c.hex)}
              className={`h-6 w-6 rounded-full border border-neutral-300 disabled:cursor-not-allowed disabled:opacity-60 dark:border-neutral-700 ${
                c.hex === value ? "ring-2 ring-neutral-900 ring-offset-2 dark:ring-neutral-100 dark:ring-offset-neutral-950" : ""
              }`}
              style={{ backgroundColor: c.hex }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

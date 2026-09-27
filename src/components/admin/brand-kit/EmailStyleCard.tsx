"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { EmailStyleInputSchema, type EmailStyleInput } from "@/lib/types/tenant";
import { BRAND_KIT_LOGOS_ROUTE, brandLogoAbsoluteUrl, brandLogoPublicUrl } from "@/lib/content/brandKit";
import { normalizeHex } from "@/lib/content/create/colorPalette";
import {
  cleanCompanyName,
  isEmailLogo,
  isLogoUrlShape,
  resolveStoredStyle,
  type BrandKitEmailStyle,
} from "@/lib/email/emailStyle";
import { renderLifecycleEmail, type RenderValues } from "@/lib/lifecycle/render";
import {
  averageInk,
  brandKitWithLogo,
  emailStyleHints,
  fitLogoSize,
  type EmailStyleLogoChoice,
  type PaletteChip,
} from "./emailStyleForm";

/**
 * Brand › Email style: the header band (logo, optional company name, header colour) and the
 * button colour that branded emails wear. "Use brand kit" fills it in from Brand; nothing
 * changes until an admin saves. The preview goes through the lifecycle renderer, so it
 * matches the send. Members see it read-only.
 */

const FIELD =
  "rounded-md border border-neutral-300 px-3 py-2 text-sm disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900";
const INPUT = `w-full ${FIELD}`;
const LABEL = "block text-sm font-medium";
const HINT = "text-xs text-neutral-500";
const BTN =
  "rounded-md border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-neutral-700";
const SWATCH =
  "h-9 w-12 shrink-0 cursor-pointer rounded border border-neutral-300 disabled:cursor-not-allowed disabled:opacity-60 dark:border-neutral-700";
const ERROR = "text-xs text-red-600 dark:text-red-400";

/** Subtle checkerboard so transparent (PNG) logos read as transparent (as in LogosGallery). */
const CHECKER: React.CSSProperties = {
  backgroundImage:
    "linear-gradient(45deg,#00000010 25%,transparent 25%,transparent 75%,#00000010 75%,#00000010)," +
    "linear-gradient(45deg,#00000010 25%,transparent 25%,transparent 75%,#00000010 75%,#00000010)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0,8px 8px",
};

const HEX_TYPED = /^#?[0-9a-f]{6}$/i;

interface Draft {
  logoId: string | null;
  companyName: string;
  headerColor: string;
  accentColor: string;
}

/** Nothing saved yet: no logo, no name, today's near-black. */
const BLANK: Draft = { logoId: null, companyName: "", headerColor: "#111111", accentColor: "#111111" };

interface LogoSample {
  width: number;
  height: number;
  /** The average colour of the logo's opaque pixels; null when the canvas couldn't be read. */
  ink: string | null;
}

/** `logos` is null when the list couldn't be loaded: the saved logo is kept, not taken as deleted. */
function toDraft(style: EmailStyleInput | null, logos: readonly EmailStyleLogoChoice[] | null): Draft {
  if (!style) return BLANK;
  const logoId = style.logo?.id ?? null;
  return {
    logoId: logoId && (!logos || logos.some((l) => l.id === logoId)) ? logoId : null,
    companyName: style.companyName ?? "",
    headerColor: style.headerColor,
    accentColor: style.accentColor,
  };
}

const sameDraft = (a: Draft, b: Draft) =>
  a.logoId === b.logoId &&
  cleanCompanyName(a.companyName) === cleanCompanyName(b.companyName) &&
  a.headerColor === b.headerColor &&
  a.accentColor === b.accentColor;

/**
 * Load a logo from its same-origin URL (the logo route sends no CORS headers, so a canvas
 * can only read it same-origin) for its display size and average colour. Null if it won't
 * load; `ink` is null if the canvas can't be read, which just skips the contrast hint.
 */
function sampleLogo(src: string): Promise<LogoSample | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const size = fitLogoSize(img.naturalWidth, img.naturalHeight);
      resolve(size ? { ...size, ink: readInk(img) } : null);
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function readInk(img: HTMLImageElement): string | null {
  try {
    const scale = Math.min(1, 64 / Math.max(img.naturalWidth, img.naturalHeight));
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

/** A short welcome email, rendered as a real branded lifecycle email. */
const SAMPLE_ITEM = {
  subject: "Welcome",
  previewText: "Two quick steps to get started",
  format: "branded" as const,
  layout: null,
  body: "Hi {{user.first_name|there}},\n\nThanks for signing up. Here's how to get started:\n\n{{block.checklist}}\n\n{{block.next_step}}",
};

function sampleValues(brand: string): RenderValues {
  return {
    user: { id: "preview", first_name: "Alex", email: "alex@example.com" },
    product: { name: brand },
    traits: {},
    facts: [],
    nextStep: { label: "Finish setting up", url: "https://example.com/start" },
    checklist: [
      { label: "Create your account", done: true, url: null },
      { label: "Invite your team", done: false, url: "https://example.com/team" },
    ],
    insight: null,
    footer: { brand, unsubscribeUrl: "#", managePreferencesUrl: "#", privacyUrl: "#", postalAddress: null },
  };
}

export function EmailStyleCard({
  initial,
  logos,
  fromBrandKit,
  palette,
  fallbackName,
  tenantId,
  logoOrigin,
  canEdit,
  logosUnavailable,
}: {
  /** The saved style; null = none, so emails have today's look. */
  initial: EmailStyleInput | null;
  /** This tenant's logos, newest first. */
  logos: EmailStyleLogoChoice[];
  /** What "Use brand kit" fills in, before the logo is measured. */
  fromBrandKit: BrandKitEmailStyle;
  /** The brand's colours, as quick picks. */
  palette: PaletteChip[];
  /** The band's name when there's no logo and no company name (the footer's sender brand). */
  fallbackName: string;
  tenantId: string;
  /** The origin emails load the logo from; empty = the preview shows the name, as the send would. */
  logoOrigin: string;
  canEdit: boolean;
  /** Why there's no logo list — Logos is off, or it failed to load — so `logos` is empty but the saved logo may not be. */
  logosUnavailable: "off" | "failed" | false;
}) {
  const listed = logosUnavailable ? null : logos;
  const [saved, setSaved] = useState<EmailStyleInput | null>(initial);
  const [draft, setDraft] = useState<Draft>(() => toDraft(initial, listed));
  // With nothing saved, the preview shows today's look until the admin starts a style.
  const [started, setStarted] = useState(initial !== null);
  // The saved logo starts at its saved size, so the preview doesn't flicker while it's re-measured.
  const [samples, setSamples] = useState<Record<string, LogoSample | "failed">>(() =>
    initial?.logo ? { [initial.logo.id]: { width: initial.logo.width, height: initial.logo.height, ink: null } } : {},
  );
  const sampling = useRef(new Map<string, Promise<LogoSample | null>>());
  const [notes, setNotes] = useState<string[]>([]);
  const [busy, setBusy] = useState<null | "kit" | "save" | "reset">(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dirty = saved ? !sameDraft(draft, toDraft(saved, listed)) : started;

  // Save is explicit; warn before losing unsaved edits (as the Colours page does).
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  /** Measure a logo once; later calls share the first load. */
  const sample = useCallback(
    (logo: EmailStyleLogoChoice) => {
      let p = sampling.current.get(logo.id);
      if (!p) {
        p = sampleLogo(brandLogoPublicUrl(tenantId, logo.filename)).then((s) => {
          setSamples((prev) => ({ ...prev, [logo.id]: s ?? "failed" }));
          return s;
        });
        sampling.current.set(logo.id, p);
      }
      return p;
    },
    [tenantId],
  );

  const selected = logos.find((l) => l.id === draft.logoId) ?? null;
  // With no list, the saved logo is offered as saved; Save sends it unchanged and the server re-checks it.
  const savedLogo = listed ? null : (saved?.logo ?? null);
  const kept = savedLogo && savedLogo.id === draft.logoId ? savedLogo : null;
  useEffect(() => {
    if (selected) void sample(selected);
  }, [selected, sample]);
  const measured = selected ? samples[selected.id] : undefined;
  const logoSample = measured && measured !== "failed" ? measured : null;
  const logoState = !selected ? "none" : !measured ? "checking" : measured === "failed" ? "failed" : "ready";

  const input: EmailStyleInput = {
    logo:
      selected && logoSample
        ? { id: selected.id, filename: selected.filename, width: logoSample.width, height: logoSample.height }
        : kept,
    companyName: cleanCompanyName(draft.companyName),
    headerColor: draft.headerColor,
    accentColor: draft.accentColor,
  };
  const check = EmailStyleInputSchema.safeParse(input);
  const nameError = check.success ? null : (check.error.issues.find((i) => i.path[0] === "companyName")?.message ?? null);

  const previewStyle = started
    ? resolveStoredStyle(input, {
        logoUrlFor: (l) => {
          const url = logoOrigin ? brandLogoAbsoluteUrl(logoOrigin, tenantId, l.filename) : "";
          return url && isLogoUrlShape(url) ? url : null;
        },
        fallbackName,
      })
    : null;
  const previewHtml = renderLifecycleEmail({ item: SAMPLE_ITEM, values: sampleValues(fallbackName), style: previewStyle }).html;
  const header = !previewStyle
    ? "No header — today's look"
    : previewStyle.logo
      ? previewStyle.name
        ? "Header: logo and name"
        : "Header: logo only"
      : "Header: name only";

  const hints = started
    ? emailStyleHints({
        logoBytes: selected?.byteSize ?? null,
        logoInk: logoSample?.ink ?? null,
        headerColor: draft.headerColor,
        accentColor: draft.accentColor,
      })
    : [];

  function edit(patch: Partial<Draft>) {
    setDraft((d) => ({ ...d, ...patch }));
    setStarted(true);
    setStatus(null);
    setError(null);
  }

  async function applyBrandKit() {
    setBusy("kit");
    try {
      const logo = logos.find((l) => l.id === fromBrandKit.logoId) ?? null;
      const s = logo ? await sample(logo) : null;
      const kit = brandKitWithLogo(fromBrandKit, s?.ink ?? null);
      edit({
        // With no list, the logo stays as it is (and the kit's "No logos yet" note doesn't apply).
        ...(listed ? { logoId: kit.logoId } : {}),
        companyName: kit.companyName ?? "",
        headerColor: kit.headerColor,
        accentColor: kit.accentColor,
      });
      setNotes(listed ? kit.notes : []);
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (!check.success) return;
    setBusy("save");
    setError(null);
    setStatus(null);
    try {
      const res = await fetch("/api/admin/brand-kit/email-style", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(check.data),
      });
      const data = (await res.json().catch(() => ({}))) as {
        emailStyle?: EmailStyleInput;
        message?: string;
        issues?: Array<{ message: string }>;
      };
      if (!res.ok || !data.emailStyle) {
        setError(
          res.status === 403
            ? "Only an admin can change the Email style."
            : (data.message ?? data.issues?.[0]?.message ?? "Couldn't save — try again."),
        );
        return;
      }
      setSaved(data.emailStyle);
      setDraft(toDraft(data.emailStyle, listed));
      setNotes([]);
      setStatus("Saved. Branded emails use this style from now on.");
    } catch {
      setError("Couldn't save — try again.");
    } finally {
      setBusy(null);
    }
  }

  async function reset() {
    if (!window.confirm("Reset to default? Your emails go back to today's look, with no header.")) return;
    setBusy("reset");
    setError(null);
    setStatus(null);
    try {
      const res = await fetch("/api/admin/brand-kit/email-style", { method: "DELETE" });
      if (!res.ok) {
        setError(res.status === 403 ? "Only an admin can change the Email style." : "Couldn't reset — try again.");
        return;
      }
      setSaved(null);
      setDraft(BLANK);
      setStarted(false);
      setNotes([]);
      setStatus("Reset. Your emails have today's look.");
    } catch {
      setError("Couldn't reset — try again.");
    } finally {
      setBusy(null);
    }
  }

  const disabled = !canEdit || busy !== null;

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="space-y-6">
        {canEdit ? (
          <div className="flex items-center justify-between gap-3 rounded-md border border-dashed border-neutral-300 p-3 dark:border-neutral-700">
            <p className={HINT}>Fill it in from Brand: your logo and colours. Review, then Save.</p>
            <button type="button" onClick={applyBrandKit} disabled={disabled} className={`shrink-0 font-medium ${BTN}`}>
              {busy === "kit" ? "Filling in…" : "Use brand kit"}
            </button>
          </div>
        ) : (
          <p className="rounded-md border border-neutral-200 px-4 py-3 text-sm text-neutral-600 dark:border-neutral-800 dark:text-neutral-300">
            Only admins can change the Email style.
          </p>
        )}
        {notes.length ? (
          <ul className="space-y-1 rounded-md border border-neutral-200 px-4 py-3 text-sm text-neutral-600 dark:border-neutral-800 dark:text-neutral-300">
            {notes.map((n) => (
              <li key={n}>{n}.</li>
            ))}
          </ul>
        ) : null}

        <fieldset className="space-y-2">
          <legend className={LABEL}>Logo</legend>
          <p className={HINT}>PNG or JPG. It sits on the header colour, up to 48 px tall.</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <LogoOption
              label="No logo"
              checked={!selected && !kept}
              disabled={disabled}
              onSelect={() => edit({ logoId: null })}
            />
            {savedLogo ? (
              <LogoOption
                label="Current logo"
                src={brandLogoPublicUrl(tenantId, savedLogo.filename)}
                checked={kept !== null}
                disabled={disabled}
                onSelect={() => edit({ logoId: savedLogo.id })}
              />
            ) : null}
            {logos.map((l) => {
              const usable = isEmailLogo(l);
              return (
                <LogoOption
                  key={l.id}
                  label={l.title}
                  src={brandLogoPublicUrl(tenantId, l.filename)}
                  badge={l.isPrimary ? "Primary" : undefined}
                  reason={usable ? undefined : l.mimeType === "image/webp" ? "WebP — Outlook can't show it" : "Email needs a PNG or JPG"}
                  checked={selected?.id === l.id}
                  disabled={disabled || !usable}
                  onSelect={() => edit({ logoId: l.id })}
                />
              );
            })}
          </div>
          {logosUnavailable === "off" ? (
            <p className={HINT}>Logos aren&rsquo;t switched on in this environment, so emails show your name in the header.</p>
          ) : !listed ? (
            <p className={HINT}>Your logos couldn&rsquo;t be loaded, so you can&rsquo;t pick another right now. Try again later.</p>
          ) : logos.length === 0 ? (
            <p className={HINT}>
              No logos yet — add a PNG or JPG in{" "}
              <Link href={BRAND_KIT_LOGOS_ROUTE} className="underline underline-offset-2">
                Brand › Logos
              </Link>
              .
            </p>
          ) : null}
          {logoState === "checking" ? <p className={HINT}>Checking your logo…</p> : null}
          {logoState === "failed" ? (
            <p role="alert" className={ERROR}>
              We couldn&rsquo;t load this logo. Pick another, or choose No logo.
            </p>
          ) : null}
        </fieldset>

        <div className="space-y-1">
          <label htmlFor="email-style-name" className={LABEL}>
            Company name <span className="font-normal text-neutral-500">(optional)</span>
          </label>
          <p id="email-style-name-hint" className={HINT}>
            {selected
              ? "Shown beside your logo. Leave blank if your logo already shows your name."
              : `With no logo, the header shows this name, or “${fallbackName}” if it's blank.`}
          </p>
          <input
            id="email-style-name"
            className={INPUT}
            maxLength={80}
            value={draft.companyName}
            disabled={disabled}
            aria-describedby="email-style-name-hint"
            aria-invalid={nameError ? true : undefined}
            onChange={(e) => edit({ companyName: e.target.value })}
          />
          {nameError ? (
            <p role="alert" className={ERROR}>
              {nameError}
            </p>
          ) : null}
        </div>

        <ColourField
          id="email-style-header"
          label="Header colour"
          hint="Behind your logo at the top of each email."
          value={draft.headerColor}
          chips={palette}
          disabled={disabled}
          onChange={(headerColor) => edit({ headerColor })}
        />
        <ColourField
          id="email-style-button"
          label="Button colour"
          hint="Buttons in branded emails. Links use it too when it's dark enough to read."
          value={draft.accentColor}
          chips={palette}
          disabled={disabled}
          onChange={(accentColor) => edit({ accentColor })}
        />

        {hints.length ? (
          <ul className="space-y-1 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
            {hints.map((h) => (
              <li key={h}>{h}.</li>
            ))}
          </ul>
        ) : null}

        {canEdit ? (
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={save}
              disabled={disabled || !dirty || !check.success || logoState === "checking" || logoState === "failed"}
              className="rounded-md bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
            >
              {busy === "save" ? "Saving…" : "Save"}
            </button>
            <button type="button" onClick={reset} disabled={disabled || !saved} className={BTN}>
              {busy === "reset" ? "Resetting…" : "Reset to default"}
            </button>
            <span role="status" className="text-xs text-neutral-500">
              {status}
            </span>
            {error ? (
              <span role="alert" className={ERROR}>
                {error}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="space-y-2 lg:sticky lg:top-4 lg:self-start">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium">Preview</h2>
          <span className={HINT}>
            {header}
            {dirty ? " · not saved yet" : ""}
          </span>
        </div>
        <iframe
          title="Preview of a branded email"
          sandbox=""
          srcDoc={previewHtml}
          className="h-[480px] w-full rounded-md border border-neutral-200 bg-white dark:border-neutral-800"
        />
        <p className={HINT}>A sample welcome email. Letters stay plain, with no header.</p>
      </div>
    </div>
  );
}

function LogoOption({
  label,
  src,
  badge,
  reason,
  checked,
  disabled,
  onSelect,
}: {
  label: string;
  src?: string;
  badge?: string;
  /** Why it can't be picked. */
  reason?: string;
  checked: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <label
      className={`flex flex-col gap-2 rounded-md border p-2 text-sm ${
        checked ? "border-neutral-900 dark:border-neutral-100" : "border-neutral-200 dark:border-neutral-800"
      } ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:border-neutral-400 dark:hover:border-neutral-600"}`}
    >
      <span className="grid h-14 place-items-center overflow-hidden rounded bg-neutral-50 dark:bg-neutral-900" style={src ? CHECKER : undefined}>
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt="" className="max-h-10 max-w-full object-contain" />
        ) : (
          <span className={HINT}>Name only</span>
        )}
      </span>
      <span className="flex items-center gap-2">
        <input type="radio" name="email-style-logo" checked={checked} disabled={disabled} onChange={onSelect} />
        <span className="min-w-0 flex-1 truncate" title={label}>
          {label}
        </span>
        {badge ? (
          <span className="shrink-0 rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
            {badge}
          </span>
        ) : null}
      </span>
      {reason ? <span className={HINT}>{reason}</span> : null}
    </label>
  );
}

function ColourField({
  id,
  label,
  hint,
  value,
  chips,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  chips: PaletteChip[];
  disabled: boolean;
  onChange: (hex: string) => void;
}) {
  // The hex box keeps what's typed; the colour only changes on a full #rrggbb.
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const hintId = `${id}-hint`;
  return (
    <fieldset className="space-y-2">
      <legend className={LABEL}>{label}</legend>
      <p id={hintId} className={HINT}>
        {hint}
      </p>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value.toLowerCase())}
          className={SWATCH}
          aria-label={`${label} picker`}
          aria-describedby={hintId}
        />
        <input
          id={id}
          className={`${FIELD} w-32 font-mono`}
          value={text}
          maxLength={7}
          spellCheck={false}
          disabled={disabled}
          aria-label={`${label} hex code`}
          aria-describedby={hintId}
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
              aria-label={c.name === c.hex ? `Use ${c.hex}` : `Use ${c.name} (${c.hex})`}
              aria-pressed={c.hex === value}
              onClick={() => onChange(c.hex)}
              className={`h-7 w-7 rounded-full border border-neutral-300 disabled:cursor-not-allowed disabled:opacity-60 dark:border-neutral-700 ${
                c.hex === value ? "ring-2 ring-neutral-900 ring-offset-2 dark:ring-neutral-100 dark:ring-offset-neutral-950" : ""
              }`}
              style={{ backgroundColor: c.hex }}
            />
          ))}
        </div>
      ) : null}
    </fieldset>
  );
}

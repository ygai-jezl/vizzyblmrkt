"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  WIDGET_TYPE_META,
  type WidgetMode,
  type WidgetType,
} from "@/lib/widget/types";
import { buildEmbedSnippet } from "@/lib/widget/snippet";
import { appendTenantParam } from "@/lib/http/tenantParam";
import {
  buildPreviewUrl,
  type PreviewMode,
  type PreviewSurface,
} from "@/lib/widget/preview";
import type { CampaignSettings } from "@/lib/admin/campaignSettings";
import type { ConfigurationStyle } from "@/lib/types/campaign";
import {
  DEFAULT_SHARE_MESSAGE,
  SHARE_PLATFORMS,
  parseEnabledPlatforms,
  renderSampleShareMessage,
  type SharePlatformId,
} from "@/lib/waitlist/socialPlatforms";
import { SocialIcon } from "@/components/waitlist/socialIcons";
import { ShareSection } from "@/components/waitlist/ShareSection";

interface CampaignOption {
  id: string;
  waitlistName: string;
  /** The campaign's current editable settings — drives the Design + Social tabs. */
  settings: CampaignSettings;
}

type Tab = "design" | "social";
type SaveStatus = "idle" | "saving" | "saved" | "error";

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
/** Stable per-row id so React keys survive add/remove (no focus loss). */
const uid = () => crypto.randomUUID();

/** Preview surfaces, Hosted first (to the left of the embeddable widget types). */
const SURFACES: { id: PreviewSurface; label: string }[] = [
  { id: "hosted", label: "Hosted" },
  { id: "WIDGET_1", label: "Full" },
  { id: "WIDGET_2", label: "Mini" },
  { id: "WIDGET_3", label: "Docked" },
];

interface LinkRow {
  id: string;
  key: string;
  value: string;
}

/** Editable branding draft (configurationStyleJson + the header toggle). */
interface BrandingDraft {
  widgetBackgroundColor: string;
  widgetButtonColor: string;
  widgetFontColor: string;
  statusDescription: string;
  joinButtonLabel: string;
  removeWidgetHeaders: boolean;
  socialLinks: LinkRow[];
}

function extractBranding(s: CampaignSettings | undefined): BrandingDraft {
  const c = s?.configurationStyleJson;
  return {
    widgetBackgroundColor: c?.widgetBackgroundColor ?? "",
    widgetButtonColor: c?.widgetButtonColor ?? "",
    widgetFontColor: c?.widgetFontColor ?? "",
    statusDescription: c?.statusDescription ?? "",
    joinButtonLabel: c?.joinButtonLabel ?? "",
    removeWidgetHeaders: s?.removeWidgetHeaders ?? false,
    socialLinks: Object.entries(c?.socialLinks ?? {}).map(([key, value]) => ({
      id: uid(),
      key,
      value,
    })),
  };
}

/**
 * Founder-facing builder for a launch's waitlist surfaces. Two sub-tabs:
 *  - Design: pick a surface (Hosted page or one of the three embed widgets) and a
 *    mode, tweak the branding (colours + copy + social links + header), see a live
 *    preview of every change, and copy the embed snippet. Branding saves through
 *    the campaign settings endpoint.
 *  - Social: choose which platforms appear as post-signup share buttons + the
 *    share message; previewed with the same ShareSection the public widget renders.
 *
 * Questions stay in the launch's Settings tab — we don't duplicate that editor.
 */
export function WidgetBuilder({
  origin,
  embedOrigin,
  tenantId,
  campaigns,
  initialCampaignId,
}: {
  /** The admin's own request origin — used for the (authenticated) preview iframe. */
  origin: string;
  /** The platform host the public snippet/hosted page load from (PLATFORM_ORIGIN). */
  embedOrigin: string;
  /** Tenant id baked into the snippet so the shared platform host resolves it. */
  tenantId: string;
  campaigns: CampaignOption[];
  initialCampaignId: string;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("design");
  const [campaignId, setCampaignId] = useState(initialCampaignId);
  const [surface, setSurface] = useState<PreviewSurface>("WIDGET_1");
  const [mode, setMode] = useState<PreviewMode>("SIGNUP");

  // Per-campaign settings, kept in state so a save can re-seed from the server.
  const [settingsById, setSettingsById] = useState<Record<string, CampaignSettings>>(
    () => Object.fromEntries(campaigns.map((c) => [c.id, c.settings])),
  );
  const settings = settingsById[campaignId];

  // Design (branding) + Social form state, seeded from the selected campaign and
  // re-seeded only when the campaign actually changes (NOT when settingsById
  // updates after a save — that would clobber the "Saved." confirmation and the
  // user's edits).
  const initialSettings = settingsById[initialCampaignId];
  const [shareMessage, setShareMessage] = useState(
    initialSettings?.configurationStyleJson.shareMessage ?? "",
  );
  const [platforms, setPlatforms] = useState<SharePlatformId[]>(() =>
    parseEnabledPlatforms(initialSettings?.configurationStyleJson.enabledSharePlatforms),
  );
  const [branding, setBranding] = useState<BrandingDraft>(() => extractBranding(initialSettings));
  const [seededFor, setSeededFor] = useState(initialCampaignId);
  const [socialDirty, setSocialDirty] = useState(false);
  const [socialStatus, setSocialStatus] = useState<SaveStatus>("idle");
  const [socialError, setSocialError] = useState<string | null>(null);
  const [brandingDirty, setBrandingDirty] = useState(false);
  const [brandingStatus, setBrandingStatus] = useState<SaveStatus>("idle");
  const [brandingError, setBrandingError] = useState<string | null>(null);

  useEffect(() => {
    if (seededFor === campaignId) return;
    const s = settingsById[campaignId];
    setShareMessage(s?.configurationStyleJson.shareMessage ?? "");
    setPlatforms(parseEnabledPlatforms(s?.configurationStyleJson.enabledSharePlatforms));
    setBranding(extractBranding(s));
    setSocialDirty(false);
    setSocialStatus("idle");
    setSocialError(null);
    setBrandingDirty(false);
    setBrandingStatus("idle");
    setBrandingError(null);
    setSeededFor(campaignId);
  }, [campaignId, seededFor, settingsById]);

  // Live preview points at the admin-only preview route, carrying the unsaved
  // branding draft so every tweak shows instantly (see lib/widget/preview).
  const previewUrl = useMemo(
    () =>
      buildPreviewUrl({
        origin,
        campaignId,
        surface,
        mode,
        draft: {
          widgetBackgroundColor: branding.widgetBackgroundColor || undefined,
          widgetButtonColor: branding.widgetButtonColor || undefined,
          widgetFontColor: branding.widgetFontColor || undefined,
          statusDescription: branding.statusDescription || undefined,
          joinButtonLabel: branding.joinButtonLabel || undefined,
          removeWidgetHeaders: branding.removeWidgetHeaders,
        },
      }),
    [origin, campaignId, surface, mode, branding],
  );

  // The snippet is for the embed widgets only; Hosted isn't embeddable.
  const widgetType: WidgetType = surface === "hosted" ? "WIDGET_1" : surface;
  // The snippet embeds the sign-up widget; the post-signup screen is just that
  // widget's success state, so "Post sign-up" reuses the SIGNUP snippet.
  const snippetMode: WidgetMode = mode === "CHECK" ? "CHECK" : "SIGNUP";
  const snippet = useMemo(
    () =>
      buildEmbedSnippet({
        origin: embedOrigin,
        campaignId,
        tenantId,
        widgetType,
        mode: snippetMode,
      }),
    [embedOrigin, campaignId, tenantId, widgetType, snippetMode],
  );
  const hostedUrl = appendTenantParam(
    `${embedOrigin.replace(/\/+$/, "")}/waitlist/${campaignId}`,
    tenantId,
  );

  async function putSettings(
    payload: CampaignSettings,
  ): Promise<{ ok: true; settings?: CampaignSettings } | { ok: false; error: string }> {
    try {
      const res = await fetch(`/api/admin/campaigns/${campaignId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const issues = Array.isArray(data.issues)
          ? data.issues
              .map((i: unknown) =>
                typeof i === "string" ? i : (i as { message?: string }).message,
              )
              .filter(Boolean)
              .join(", ")
          : null;
        return { ok: false, error: issues || data.error || "Save failed." };
      }
      return { ok: true, settings: data.settings as CampaignSettings | undefined };
    } catch {
      return { ok: false, error: "Network error — please try again." };
    }
  }

  function togglePlatform(id: SharePlatformId) {
    setSocialDirty(true);
    setSocialStatus("idle");
    setPlatforms((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id],
    );
  }

  function updateBranding(patch: Partial<BrandingDraft>) {
    setBranding((b) => ({ ...b, ...patch }));
    setBrandingDirty(true);
    setBrandingStatus("idle");
  }

  async function saveSocial() {
    if (!settings) return;
    setSocialStatus("saving");
    setSocialError(null);
    const trimmed = shareMessage.trim();
    const payload: CampaignSettings = {
      ...settings,
      configurationStyleJson: {
        ...settings.configurationStyleJson,
        shareMessage: trimmed ? trimmed : undefined,
        enabledSharePlatforms: parseEnabledPlatforms(platforms),
      },
    };
    const r = await putSettings(payload);
    if (!r.ok) {
      setSocialError(r.error);
      setSocialStatus("error");
      return;
    }
    if (r.settings) setSettingsById((m) => ({ ...m, [campaignId]: r.settings! }));
    setSocialDirty(false);
    setSocialStatus("saved");
    router.refresh();
  }

  async function saveBranding() {
    if (!settings) return;
    setBrandingStatus("saving");
    setBrandingError(null);
    const links: Record<string, string> = {};
    for (const { key, value } of branding.socialLinks) {
      const k = key.trim();
      if (k) links[k] = value.trim();
    }
    const trim = (v: string) => {
      const t = v.trim();
      return t ? t : undefined;
    };
    // Branding edits write disjoint keys from the Social tab (share message /
    // platforms), and both spread the freshest `settings`, so neither clobbers
    // the other. undefined values drop out of the JSON payload (= cleared).
    const style: ConfigurationStyle = {
      ...settings.configurationStyleJson,
      widgetBackgroundColor: trim(branding.widgetBackgroundColor),
      widgetButtonColor: trim(branding.widgetButtonColor),
      widgetFontColor: trim(branding.widgetFontColor),
      statusDescription: trim(branding.statusDescription),
      joinButtonLabel: trim(branding.joinButtonLabel),
      socialLinks: Object.keys(links).length > 0 ? links : undefined,
    };
    const payload: CampaignSettings = {
      ...settings,
      removeWidgetHeaders: branding.removeWidgetHeaders,
      configurationStyleJson: style,
    };
    const r = await putSettings(payload);
    if (!r.ok) {
      setBrandingError(r.error);
      setBrandingStatus("error");
      return;
    }
    if (r.settings) setSettingsById((m) => ({ ...m, [campaignId]: r.settings! }));
    setBrandingDirty(false);
    setBrandingStatus("saved");
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="text-sm text-neutral-500">
          Campaign{" "}
          <select
            value={campaignId}
            onChange={(e) => setCampaignId(e.target.value)}
            className="ml-1 rounded-md border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          >
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.waitlistName}
              </option>
            ))}
          </select>
        </label>

        <div className="flex gap-2">
          {(["design", "social"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`rounded-md border px-3 py-1.5 text-sm capitalize ${
                t === tab
                  ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                  : "border-neutral-300 dark:border-neutral-700"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {tab === "design" ? (
        <DesignTab
          surface={surface}
          setSurface={setSurface}
          mode={mode}
          setMode={setMode}
          branding={branding}
          updateBranding={updateBranding}
          brandingDirty={brandingDirty}
          brandingStatus={brandingStatus}
          brandingError={brandingError}
          onSaveBranding={saveBranding}
          previewUrl={previewUrl}
          snippet={snippet}
          hostedUrl={hostedUrl}
        />
      ) : (
        <SocialTab
          waitlistName={
            campaigns.find((c) => c.id === campaignId)?.waitlistName ?? "your waitlist"
          }
          shareMessage={shareMessage}
          setShareMessage={(v) => {
            setShareMessage(v);
            setSocialDirty(true);
            setSocialStatus("idle");
          }}
          platforms={platforms}
          togglePlatform={togglePlatform}
          buttonColor={branding.widgetButtonColor || "#111827"}
          dirty={socialDirty}
          saveStatus={socialStatus}
          saveError={socialError}
          onSave={saveSocial}
        />
      )}
    </div>
  );
}

function DesignTab({
  surface,
  setSurface,
  mode,
  setMode,
  branding,
  updateBranding,
  brandingDirty,
  brandingStatus,
  brandingError,
  onSaveBranding,
  previewUrl,
  snippet,
  hostedUrl,
}: {
  surface: PreviewSurface;
  setSurface: (s: PreviewSurface) => void;
  mode: PreviewMode;
  setMode: (m: PreviewMode) => void;
  branding: BrandingDraft;
  updateBranding: (patch: Partial<BrandingDraft>) => void;
  brandingDirty: boolean;
  brandingStatus: SaveStatus;
  brandingError: string | null;
  onSaveBranding: () => void;
  previewUrl: string;
  snippet: string;
  hostedUrl: string;
}) {
  const [copied, setCopied] = useState<"snippet" | "link" | null>(null);
  const isHosted = surface === "hosted";
  const description = isHosted
    ? "Your standalone YouGrow.ai waitlist page — the full experience hosted at /waitlist."
    : WIDGET_TYPE_META[surface].description;
  const links = branding.socialLinks;

  async function copy(text: string, which: "snippet" | "link") {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* selectable as a fallback */
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        {SURFACES.map((s) => {
          const active = s.id === surface;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setSurface(s.id)}
              className={`rounded-md border px-3 py-1.5 text-sm ${
                active
                  ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                  : "border-neutral-300 dark:border-neutral-700"
              }`}
            >
              {s.label}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-neutral-500">{description}</p>

      {!isHosted ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-neutral-500">Mode</span>
            {(
              [
                ["SIGNUP", "Sign-up"],
                ["CHECK", "Check status"],
                ["SUCCESS", "Post sign-up"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setMode(value)}
                className={`rounded-md border px-3 py-1 text-xs ${
                  mode === value
                    ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                    : "border-neutral-300 dark:border-neutral-700"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {mode === "SUCCESS" ? (
            <p className="text-xs text-neutral-500">
              The payoff screen visitors see right after joining — shown with
              sample position and referral data. Share buttons come from the
              Social tab. The embed snippet below stays the sign-up widget.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Branding controls */}
        <section className="space-y-4">
          <h2 className="text-sm font-semibold">Branding</h2>
          <ColorField
            label="Background colour"
            value={branding.widgetBackgroundColor}
            onChange={(v) => updateBranding({ widgetBackgroundColor: v })}
          />
          <ColorField
            label="Button colour"
            value={branding.widgetButtonColor}
            onChange={(v) => updateBranding({ widgetButtonColor: v })}
          />
          <ColorField
            label="Font colour"
            value={branding.widgetFontColor}
            onChange={(v) => updateBranding({ widgetFontColor: v })}
          />
          <Field
            label="Success message"
            value={branding.statusDescription}
            onChange={(v) => updateBranding({ statusDescription: v })}
            placeholder="You're on the list!"
          />
          <Field
            label="Join button text"
            value={branding.joinButtonLabel}
            onChange={(v) => updateBranding({ joinButtonLabel: v })}
            placeholder="Join the waitlist"
          />
          <div className="space-y-2">
            <label className="block text-sm font-medium">Social links</label>
            {links.length === 0 ? (
              <p className="text-sm text-neutral-500">No social links.</p>
            ) : null}
            {links.map((l, i) => (
              <div key={l.id} className="flex items-center gap-2">
                <input
                  value={l.key}
                  onChange={(e) =>
                    updateBranding({
                      socialLinks: links.map((s, idx) =>
                        idx === i ? { ...s, key: e.target.value } : s,
                      ),
                    })
                  }
                  placeholder="Label (e.g. twitter)"
                  aria-label="Social link label"
                  className="w-36 rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
                <input
                  value={l.value}
                  onChange={(e) =>
                    updateBranding({
                      socialLinks: links.map((s, idx) =>
                        idx === i ? { ...s, value: e.target.value } : s,
                      ),
                    })
                  }
                  placeholder="https://…"
                  aria-label="Social link URL"
                  className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
                <button
                  type="button"
                  onClick={() =>
                    updateBranding({ socialLinks: links.filter((_, idx) => idx !== i) })
                  }
                  className="rounded-md border border-red-300 px-2.5 py-2 text-xs text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400"
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() =>
                updateBranding({ socialLinks: [...links, { id: uid(), key: "", value: "" }] })
              }
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              + Add link
            </button>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={branding.removeWidgetHeaders}
              onChange={(e) => updateBranding({ removeWidgetHeaders: e.target.checked })}
              className="h-4 w-4 rounded border-neutral-300"
            />
            <span>Remove widget header (title)</span>
            {isHosted ? (
              <span className="text-xs text-neutral-400">(hosted page always shows it)</span>
            ) : null}
          </label>

          <div className="flex items-center gap-3 pt-1">
            <button
              type="button"
              onClick={onSaveBranding}
              disabled={!brandingDirty || brandingStatus === "saving"}
              className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
            >
              {brandingStatus === "saving" ? "Saving…" : "Save branding"}
            </button>
            {brandingStatus === "saved" && !brandingDirty ? (
              <span className="text-xs text-green-600">Saved.</span>
            ) : brandingDirty ? (
              <span className="text-xs text-neutral-500">Unsaved changes.</span>
            ) : null}
            {brandingStatus === "error" ? (
              <span className="text-xs text-red-600">{brandingError}</span>
            ) : null}
          </div>
        </section>

        {/* Live preview */}
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Live preview</h2>
          <div className="sticky top-4 rounded-lg border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900/40">
            <iframe
              key={previewUrl}
              src={previewUrl}
              title="Live preview"
              className="w-full"
              style={{ height: 420, border: 0 }}
            />
          </div>
        </section>
      </div>

      {isHosted ? (
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Hosted page</h2>
            <div className="flex gap-2">
              <a
                href={hostedUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded-md border border-neutral-300 px-3 py-1 text-xs dark:border-neutral-700"
              >
                Open ↗
              </a>
              <button
                type="button"
                onClick={() => copy(hostedUrl, "link")}
                className="rounded-md border border-neutral-300 px-3 py-1 text-xs dark:border-neutral-700"
              >
                {copied === "link" ? "Copied" : "Copy link"}
              </button>
            </div>
          </div>
          <pre className="overflow-x-auto rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-xs dark:border-neutral-800 dark:bg-neutral-900/40">
            <code>{hostedUrl}</code>
          </pre>
          <p className="text-xs text-neutral-500">
            Your standalone waitlist page. Share the link directly, or set it as your
            launch&apos;s Waitlist URL in Settings.
          </p>
        </section>
      ) : (
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Embed snippet</h2>
            <button
              type="button"
              onClick={() => copy(snippet, "snippet")}
              className="rounded-md border border-neutral-300 px-3 py-1 text-xs dark:border-neutral-700"
            >
              {copied === "snippet" ? "Copied" : "Copy"}
            </button>
          </div>
          <pre className="overflow-x-auto rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-xs dark:border-neutral-800 dark:bg-neutral-900/40">
            <code>{snippet}</code>
          </pre>
          <p className="text-xs text-neutral-500">
            Paste this where you want the widget to appear. The loader turns the div
            into a self-resizing iframe. Add{" "}
            <code className="rounded bg-neutral-100 px-1 dark:bg-neutral-800">
              data-vizzybl-ref
            </code>{" "}
            to pass a referral token through.
          </p>
        </section>
      )}
    </div>
  );
}

function SocialTab({
  waitlistName,
  shareMessage,
  setShareMessage,
  platforms,
  togglePlatform,
  buttonColor,
  dirty,
  saveStatus,
  saveError,
  onSave,
}: {
  waitlistName: string;
  shareMessage: string;
  setShareMessage: (v: string) => void;
  platforms: SharePlatformId[];
  togglePlatform: (id: SharePlatformId) => void;
  buttonColor: string;
  dirty: boolean;
  saveStatus: SaveStatus;
  saveError: string | null;
  onSave: () => void;
}) {
  const resolved = renderSampleShareMessage(shareMessage || DEFAULT_SHARE_MESSAGE, waitlistName);
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section className="space-y-5">
        <div className="space-y-1">
          <label className="text-sm font-medium">Share message</label>
          <textarea
            value={shareMessage}
            onChange={(e) => setShareMessage(e.target.value)}
            rows={3}
            maxLength={280}
            placeholder={DEFAULT_SHARE_MESSAGE}
            className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
          <p className="text-xs text-neutral-500">
            Tokens:{" "}
            <code className="rounded bg-neutral-100 px-1 dark:bg-neutral-800">
              {"{{first_name}}"}
            </code>{" "}
            <code className="rounded bg-neutral-100 px-1 dark:bg-neutral-800">
              {"{{current_rank}}"}
            </code>{" "}
            <code className="rounded bg-neutral-100 px-1 dark:bg-neutral-800">
              {"{{referral_count}}"}
            </code>{" "}
            <code className="rounded bg-neutral-100 px-1 dark:bg-neutral-800">
              {"{{waitlist_name}}"}
            </code>
            . The referral link is added automatically.
          </p>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium">Show these share buttons after signup</p>
          <div className="space-y-1.5">
            {SHARE_PLATFORMS.map((p) => (
              <label key={p.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={platforms.includes(p.id)}
                  onChange={() => togglePlatform(p.id)}
                />
                <SocialIcon id={p.id} size={16} className="text-neutral-500" />
                <span>{p.label}</span>
                {!p.supportsText ? (
                  <span className="text-xs text-neutral-400">(posts the link only)</span>
                ) : null}
              </label>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onSave}
            disabled={!dirty || saveStatus === "saving"}
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {saveStatus === "saving" ? "Saving…" : "Save"}
          </button>
          {saveStatus === "saved" ? (
            <span className="text-xs text-green-600">Saved.</span>
          ) : null}
          {saveStatus === "error" ? (
            <span className="text-xs text-red-600">{saveError}</span>
          ) : null}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Post-signup preview</h2>
        <div className="rounded-xl border border-neutral-200 p-5 text-center dark:border-neutral-800">
          <h3 className="mb-4 text-lg font-semibold">You&apos;re on the list!</h3>
          <ShareSection
            referralLink="https://example.com/waitlist?ref=DEMO1234"
            shareMessage={resolved}
            enabledPlatforms={platforms}
            rank={42}
            amountReferred={3}
            hideCounts={false}
            buttonColor={buttonColor}
          />
        </div>
        <p className="text-xs text-neutral-500">
          Sample data — the real widget shows each visitor&apos;s own position and
          link.
        </p>
      </section>
    </div>
  );
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <label className="block text-sm font-medium">{label}</label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={HEX_RE.test(value) ? value : "#000000"}
          onChange={(e) => onChange(e.target.value)}
          aria-label={`${label} swatch`}
          className="h-9 w-12 cursor-pointer rounded border border-neutral-300 bg-transparent dark:border-neutral-700"
        />
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="#000000"
          className="w-32 rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1">
      <label className="block text-sm font-medium">{label}</label>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
      />
    </div>
  );
}

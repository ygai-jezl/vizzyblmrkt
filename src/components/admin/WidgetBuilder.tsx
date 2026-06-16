"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  WIDGET_TYPES,
  WIDGET_TYPE_META,
  type WidgetMode,
  type WidgetType,
} from "@/lib/widget/types";
import { buildEmbedSnippet, buildEmbedUrl } from "@/lib/widget/snippet";
import type { CampaignSettings } from "@/lib/admin/campaignSettings";
import {
  DEFAULT_SHARE_MESSAGE,
  SHARE_PLATFORMS,
  parseEnabledPlatforms,
  type SharePlatformId,
} from "@/lib/waitlist/socialPlatforms";
import { SocialIcon } from "@/components/waitlist/socialIcons";
import { ShareSection } from "@/components/waitlist/ShareSection";

interface CampaignOption {
  id: string;
  waitlistName: string;
  /** The campaign's current editable settings — drives the Social tab. */
  settings: CampaignSettings;
}

type Tab = "design" | "social";

/** Sample merge-var substitution so the Social preview reads naturally. */
function previewMessage(template: string, waitlistName: string): string {
  return template
    .replace(/\{\{\s*waitlist_name\s*\}\}/g, waitlistName)
    .replace(/\{\{\s*first_name\s*\}\}/g, "Alex")
    .replace(/\{\{\s*current_rank\s*\}\}/g, "42")
    .replace(/\{\{\s*referral_count\s*\}\}/g, "3")
    .replace(/\{\{\s*referral_link\s*\}\}/g, "")
    .trim();
}

/**
 * Founder-facing widget builder. Two sub-tabs:
 *  - Design: pick a widget type + mode, see a live iframe preview, copy the embed
 *    snippet.
 *  - Social: choose which platforms appear as post-signup share buttons and the
 *    share message; saved through the campaign settings endpoint and previewed
 *    with the same ShareSection the public widget renders.
 *
 * Questions stay in the launch's Settings tab — we don't duplicate that editor.
 */
export function WidgetBuilder({
  origin,
  campaigns,
  initialCampaignId,
}: {
  origin: string;
  campaigns: CampaignOption[];
  initialCampaignId: string;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("design");
  const [campaignId, setCampaignId] = useState(initialCampaignId);
  const [widgetType, setWidgetType] = useState<WidgetType>("WIDGET_1");
  const [mode, setMode] = useState<WidgetMode>("SIGNUP");
  const [copied, setCopied] = useState(false);

  // Per-campaign settings, kept in state so a save can re-seed from the server.
  const [settingsById, setSettingsById] = useState<Record<string, CampaignSettings>>(
    () => Object.fromEntries(campaigns.map((c) => [c.id, c.settings])),
  );
  const settings = settingsById[campaignId];
  const buttonColor = settings?.configurationStyleJson.widgetButtonColor ?? "#111827";

  // Social form state, seeded from the initial campaign and re-seeded only when
  // the selected campaign actually changes (NOT when settingsById updates after a
  // save — that would clobber the "Saved." confirmation and the user's edits).
  const initialStyle = settingsById[initialCampaignId]?.configurationStyleJson;
  const [shareMessage, setShareMessage] = useState(initialStyle?.shareMessage ?? "");
  const [platforms, setPlatforms] = useState<SharePlatformId[]>(() =>
    parseEnabledPlatforms(initialStyle?.enabledSharePlatforms),
  );
  const [seededFor, setSeededFor] = useState(initialCampaignId);
  const [dirty, setDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (seededFor === campaignId) return;
    const style = settingsById[campaignId]?.configurationStyleJson;
    setShareMessage(style?.shareMessage ?? "");
    setPlatforms(parseEnabledPlatforms(style?.enabledSharePlatforms));
    setDirty(false);
    setSaveStatus("idle");
    setSaveError(null);
    setSeededFor(campaignId);
  }, [campaignId, seededFor, settingsById]);

  const previewUrl = useMemo(
    () => buildEmbedUrl({ origin, campaignId, widgetType, mode }),
    [origin, campaignId, widgetType, mode],
  );
  const snippet = useMemo(
    () => buildEmbedSnippet({ origin, campaignId, widgetType, mode }),
    [origin, campaignId, widgetType, mode],
  );

  function togglePlatform(id: SharePlatformId) {
    setDirty(true);
    setSaveStatus("idle");
    setPlatforms((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id],
    );
  }

  async function save() {
    if (!settings) return;
    setSaveStatus("saving");
    setSaveError(null);
    const trimmed = shareMessage.trim();
    const payload: CampaignSettings = {
      ...settings,
      configurationStyleJson: {
        ...settings.configurationStyleJson,
        shareMessage: trimmed ? trimmed : undefined,
        enabledSharePlatforms: parseEnabledPlatforms(platforms),
      },
    };
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
              .join(", ")
          : null;
        setSaveError(issues || data.error || "Save failed.");
        setSaveStatus("error");
        return;
      }
      if (data.settings) {
        setSettingsById((m) => ({ ...m, [campaignId]: data.settings }));
      }
      setDirty(false);
      setSaveStatus("saved");
      router.refresh();
    } catch {
      setSaveError("Network error — please try again.");
      setSaveStatus("error");
    }
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
          widgetType={widgetType}
          setWidgetType={setWidgetType}
          mode={mode}
          setMode={setMode}
          previewUrl={previewUrl}
          snippet={snippet}
          copied={copied}
          onCopy={async () => {
            try {
              await navigator.clipboard.writeText(snippet);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              /* selectable below as a fallback */
            }
          }}
        />
      ) : (
        <SocialTab
          waitlistName={
            campaigns.find((c) => c.id === campaignId)?.waitlistName ?? "your waitlist"
          }
          shareMessage={shareMessage}
          setShareMessage={(v) => {
            setShareMessage(v);
            setDirty(true);
            setSaveStatus("idle");
          }}
          platforms={platforms}
          togglePlatform={togglePlatform}
          buttonColor={buttonColor}
          dirty={dirty}
          saveStatus={saveStatus}
          saveError={saveError}
          onSave={save}
        />
      )}
    </div>
  );
}

function DesignTab({
  widgetType,
  setWidgetType,
  mode,
  setMode,
  previewUrl,
  snippet,
  copied,
  onCopy,
}: {
  widgetType: WidgetType;
  setWidgetType: (t: WidgetType) => void;
  mode: WidgetMode;
  setMode: (m: WidgetMode) => void;
  previewUrl: string;
  snippet: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        {WIDGET_TYPES.map((t) => {
          const meta = WIDGET_TYPE_META[t];
          const active = t === widgetType;
          return (
            <button
              key={t}
              type="button"
              onClick={() => setWidgetType(t)}
              className={`rounded-md border px-3 py-1.5 text-sm ${
                active
                  ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                  : "border-neutral-300 dark:border-neutral-700"
              }`}
            >
              {meta.label}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-neutral-500">
        {WIDGET_TYPE_META[widgetType].description}
      </p>

      <div className="flex items-center gap-2 text-sm">
        <span className="text-neutral-500">Mode</span>
        {(
          [
            ["SIGNUP", "Sign-up"],
            ["CHECK", "Check status"],
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

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Live preview</h2>
          <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900/40">
            <iframe
              key={previewUrl}
              src={previewUrl}
              title="Widget preview"
              className="w-full"
              style={{ height: 360, border: 0 }}
            />
          </div>
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Embed snippet</h2>
            <button
              type="button"
              onClick={onCopy}
              className="rounded-md border border-neutral-300 px-3 py-1 text-xs dark:border-neutral-700"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <pre className="overflow-x-auto rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-xs dark:border-neutral-800 dark:bg-neutral-900/40">
            <code>{snippet}</code>
          </pre>
          <p className="text-xs text-neutral-500">
            Paste this where you want the widget to appear. The loader turns the
            div into a self-resizing iframe. Add{" "}
            <code className="rounded bg-neutral-100 px-1 dark:bg-neutral-800">
              data-vizzybl-ref
            </code>{" "}
            to pass a referral token through.
          </p>
        </section>
      </div>
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
  saveStatus: "idle" | "saving" | "saved" | "error";
  saveError: string | null;
  onSave: () => void;
}) {
  const resolved = previewMessage(shareMessage || DEFAULT_SHARE_MESSAGE, waitlistName);
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
              <label
                key={p.id}
                className="flex items-center gap-2 text-sm"
              >
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

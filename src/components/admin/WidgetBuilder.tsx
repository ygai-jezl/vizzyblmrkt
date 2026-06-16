"use client";

import { useMemo, useState } from "react";
import {
  WIDGET_TYPES,
  WIDGET_TYPE_META,
  type WidgetType,
} from "@/lib/widget/types";
import { buildEmbedSnippet, buildEmbedUrl } from "@/lib/widget/snippet";

interface CampaignOption {
  id: string;
  waitlistName: string;
}

/**
 * Founder-facing widget builder: pick a campaign + widget type, see a live
 * preview (a real iframe of the embed route), and copy the embed snippet.
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
  const [campaignId, setCampaignId] = useState(initialCampaignId);
  const [widgetType, setWidgetType] = useState<WidgetType>("WIDGET_1");
  const [copied, setCopied] = useState(false);

  const previewUrl = useMemo(
    () => buildEmbedUrl({ origin, campaignId, widgetType }),
    [origin, campaignId, widgetType],
  );
  const snippet = useMemo(
    () => buildEmbedSnippet({ origin, campaignId, widgetType }),
    [origin, campaignId, widgetType],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
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
      </div>

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
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(snippet);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                } catch {
                  /* selectable below as a fallback */
                }
              }}
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

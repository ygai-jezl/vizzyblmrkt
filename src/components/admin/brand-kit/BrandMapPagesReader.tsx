"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { BackfillCursor, BackfillStep } from "@/lib/brandMap/backfill";
import { api, errorText } from "@/components/admin/connect/api";
import { Banner, Button, Section } from "@/components/admin/connect/ui";

/** Calls past this many are a runaway, not a big site. */
const MAX_CALLS = 400;

/**
 * "Read what's already there": puts the brand's existing articles, and the pages its
 * programmes have crawled on its site, on the map. A batch per call until done.
 */
export function BrandMapPagesReader() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [read, setRead] = useState({ articles: 0, sitePages: 0, removed: 0 });
  const [note, setNote] = useState<{ tone: "ok" | "err" | "info"; text: string } | null>(null);

  async function run() {
    setBusy(true);
    setNote(null);
    const total = { articles: 0, sitePages: 0, removed: 0 };
    setRead(total);
    let cursor: BackfillCursor | null = null;
    for (let call = 0; call < MAX_CALLS; call += 1) {
      const r: { ok: boolean; data: BackfillStep & { error?: string } } = await api<BackfillStep & { error?: string }>("/api/admin/brand-kit/map/pages", {
        method: "POST",
        body: JSON.stringify({ cursor }),
      });
      if (!r.ok) {
        setNote({ tone: "err", text: errorText(r.data) });
        break;
      }
      total.articles += r.data.articles;
      total.sitePages += r.data.sitePages;
      total.removed += r.data.removed;
      setRead({ ...total });
      if (r.data.done || !r.data.next) {
        setNote(
          r.data.noSite
            ? { tone: "info", text: "Articles read. Add your site on the map (or a domain in Settings) to read the pages already on it." }
            : { tone: "ok", text: "Read. The map now shows what your pages answer." },
        );
        router.refresh();
        break;
      }
      cursor = r.data.next;
    }
    setBusy(false);
  }

  return (
    <Section title="Your pages" description="Articles written here, and the pages your programmes have read on your site.">
      <Button disabled={busy} onClick={() => void run()}>
        {busy ? "Reading…" : "Read what's already there"}
      </Button>
      {busy || read.articles || read.sitePages ? (
        <p role="status" className="text-xs text-neutral-500">
          {read.articles} article{read.articles === 1 ? "" : "s"} and {read.sitePages} page{read.sitePages === 1 ? "" : "s"} read
          {read.removed ? `, ${read.removed} no longer there taken off` : ""}.
        </p>
      ) : null}
      {note ? <Banner tone={note.tone}>{note.text}</Banner> : null}
    </Section>
  );
}

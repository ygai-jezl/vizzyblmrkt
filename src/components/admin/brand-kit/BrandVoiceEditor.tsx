"use client";

import { useEffect, useState } from "react";
import type { BrandVoice } from "@/lib/types/tenant";

/**
 * Brand Kit → Brand voice. Author the tenant-GLOBAL brand voice (Summary / Do / Don't /
 * free-text guidelines). One voice per brand; it grounds all AI-generated copy. Persists to
 * the top-level `tenant.brandVoice` field (never touches the PDF-extracted brandKit), so a
 * Brand-guidelines re-extract can't clobber it. Plain fetch GET/PUT/DELETE, mirroring
 * BrandSettings.tsx (no hook / react-query).
 */
const INPUT =
  "w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900";
const LABEL = "block text-sm font-medium";
const HINT = "text-xs text-neutral-500";

// Schema caps (keep in sync with BrandVoiceSchema in src/lib/types/tenant.ts).
const SUMMARY_MAX = 500;
const GUIDELINES_MAX = 2000;
const ITEM_MAX = 300; // per Do/Don't line
const ITEMS_MAX = 12; // max Do/Don't lines

function lines(s: string): string[] {
  return s.split("\n").map((l) => l.trim()).filter(Boolean);
}

export function BrandVoiceEditor() {
  const [summary, setSummary] = useState("");
  const [dosText, setDosText] = useState("");
  const [dontsText, setDontsText] = useState("");
  const [guidelines, setGuidelines] = useState("");
  // Provenance (from an AI-generated draft or a previously-saved voice); round-tripped on save.
  const [sourceDomain, setSourceDomain] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "load" | "save" | "delete" | "generate">("load");
  const [msg, setMsg] = useState<string | null>(null);

  function apply(v: BrandVoice | null) {
    setSummary(v?.summary ?? "");
    setDosText((v?.dos ?? []).join("\n"));
    setDontsText((v?.donts ?? []).join("\n"));
    setGuidelines(v?.guidelines ?? "");
    setSourceDomain(v?.sourceDomain ?? null);
    setGeneratedAt(v?.generatedAt ?? null);
  }

  async function load() {
    setBusy("load");
    try {
      const res = await fetch("/api/admin/account/brand/voice");
      const data = (await res.json().catch(() => ({}))) as { brandVoice?: BrandVoice | null };
      apply(data.brandVoice ?? null);
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onSave() {
    setBusy("save");
    setMsg(null);
    // Cap items AND per-line length client-side to match the schema (each item <= 300 chars,
    // <= 12 items), so a long pasted bullet is gracefully trimmed rather than 400-ing the save.
    const payload: BrandVoice = {
      summary: summary.trim() || null,
      dos: lines(dosText).map((l) => l.slice(0, ITEM_MAX)).slice(0, ITEMS_MAX),
      donts: lines(dontsText).map((l) => l.slice(0, ITEM_MAX)).slice(0, ITEMS_MAX),
      guidelines: guidelines.trim() || null,
      sourceDomain,
      generatedAt,
    };
    try {
      const res = await fetch("/api/admin/account/brand/voice", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setMsg(res.ok ? "Saved." : "Save failed — please try again.");
    } finally {
      setBusy(null);
    }
  }

  async function onGenerate() {
    setBusy("generate");
    setMsg("Reading your website and drafting a brand voice…");
    try {
      const res = await fetch("/api/admin/account/brand/voice/generate", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { brandVoice?: BrandVoice; error?: string };
      if (res.ok && data.brandVoice) {
        apply(data.brandVoice);
        setMsg("Drafted from your website — review, edit, then Save.");
      } else if (data.error === "no_primary_domain") {
        setMsg("Set your Primary Domain in Account → Domains first, then generate.");
      } else {
        setMsg("Couldn't generate a brand voice — try again or write it manually.");
      }
    } finally {
      setBusy(null);
    }
  }

  async function onDelete() {
    setBusy("delete");
    setMsg(null);
    try {
      const res = await fetch("/api/admin/account/brand/voice", { method: "DELETE" });
      if (res.ok) apply(null);
      setMsg(res.ok ? "Deleted." : "Delete failed.");
    } finally {
      setBusy(null);
    }
  }

  const disabled = busy !== null;

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center justify-between gap-3 rounded-md border border-dashed border-neutral-300 p-3 dark:border-neutral-700">
        <p className={HINT}>
          {sourceDomain
            ? `Generated from ${sourceDomain}. Edit below, then Save.`
            : "Let AI draft your brand voice from your website, then refine it."}
        </p>
        <button
          type="button"
          onClick={onGenerate}
          disabled={disabled}
          className="shrink-0 rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium disabled:opacity-60 dark:border-neutral-700"
        >
          {busy === "generate" ? "Generating…" : "✨ Generate with AI"}
        </button>
      </div>

      <Field
        label="Summary"
        hint="What your brand voice achieves and when to use it."
        counter={{ value: summary.length, max: SUMMARY_MAX }}
      >
        <textarea
          rows={3}
          maxLength={SUMMARY_MAX}
          className={INPUT}
          placeholder="Describe what your brand voice achieves and when to use it"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="✓ Do" hint="Guidance for tone, vocabulary, key messages. One per line.">
          <textarea
            rows={5}
            className={INPUT}
            placeholder="Add guidance for tone, vocabulary, key messages"
            value={dosText}
            onChange={(e) => setDosText(e.target.value)}
          />
        </Field>
        <Field label="✕ Don't" hint="Common mistakes to avoid. One per line.">
          <textarea
            rows={5}
            className={INPUT}
            placeholder="Add common mistakes to avoid for brand voice"
            value={dontsText}
            onChange={(e) => setDontsText(e.target.value)}
          />
        </Field>
      </div>

      <Field
        label="Guidelines"
        hint="Free-text guidelines describing how to write in your brand voice."
        counter={{ value: guidelines.length, max: GUIDELINES_MAX }}
      >
        <textarea
          rows={5}
          maxLength={GUIDELINES_MAX}
          className={INPUT}
          placeholder="Describe your brand's unique personality and how you communicate with your audience. For example, “our voice is confident, casual, and friendly.”"
          value={guidelines}
          onChange={(e) => setGuidelines(e.target.value)}
        />
      </Field>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onSave}
          disabled={disabled}
          className="rounded-md bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-60 dark:bg-white dark:text-neutral-900"
        >
          {busy === "save" ? "Saving…" : "Save brand voice"}
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={disabled}
          className="rounded-md border border-neutral-300 px-4 py-1.5 text-sm text-red-600 disabled:opacity-60 dark:border-neutral-700"
        >
          Delete
        </button>
        {msg ? <span className="text-sm text-neutral-500">{msg}</span> : null}
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  counter,
  children,
}: {
  label: string;
  hint?: string;
  counter?: { value: number; max: number };
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <div className={LABEL}>{label}</div>
        {counter ? (
          <span className={HINT}>
            {counter.value}/{counter.max}
          </span>
        ) : null}
      </div>
      {hint ? <div className={HINT}>{hint}</div> : null}
      {children}
    </div>
  );
}

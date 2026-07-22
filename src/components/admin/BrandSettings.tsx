"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BrandKit } from "@/lib/types/tenant";
import { BrandColours } from "./brand-kit/BrandColours";

/**
 * Account → Brand. Upload a brand-guidelines PDF → AI-extract a structured brand kit
 * (colours / fonts / tone / imagery / do's & don'ts), then review + edit + save. The
 * kit powers on-brand AI generation (email layouts + images). Every field is optional,
 * so a sparse guideline still yields a usable (mostly-null) kit.
 */
const INPUT =
  "w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900";
const LABEL = "block text-sm font-medium";
const HINT = "text-xs text-neutral-500";

function lines(s: string): string[] {
  return s.split("\n").map((l) => l.trim()).filter(Boolean);
}

export function BrandSettings() {
  const [kit, setKit] = useState<BrandKit>({});
  const [fontsText, setFontsText] = useState("");
  const [dosText, setDosText] = useState("");
  const [dontsText, setDontsText] = useState("");
  const [pdfPath, setPdfPath] = useState<string | null>(null);
  const [pdfName, setPdfName] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "upload" | "extract" | "save">(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [colorsDirty, setColorsDirty] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function applyKit(k: BrandKit) {
    setKit(k);
    setFontsText((k.fonts ?? []).join("\n"));
    setDosText((k.dos ?? []).join("\n"));
    setDontsText((k.donts ?? []).join("\n"));
    setPdfPath(k.pdfPath ?? null);
    setPdfName(k.pdfName ?? null);
    setColorsDirty(false);
  }

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/admin/account/brand");
      const data = (await res.json().catch(() => ({}))) as { brandKit?: BrandKit | null };
      if (data.brandKit) applyKit(data.brandKit);
    })();
  }, []);

  const onExtract = useCallback(
    async (path: string, name: string | null) => {
      setBusy("extract");
      setMsg("Extracting brand kit with AI…");
      try {
        const res = await fetch("/api/admin/account/brand/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pdfPath: path, pdfName: name }),
        });
        const data = (await res.json().catch(() => ({}))) as { brandKit?: BrandKit };
        if (res.ok && data.brandKit) {
          applyKit(data.brandKit);
          setMsg("Brand kit extracted — review and save.");
        } else {
          setMsg("Extraction failed — try another PDF or fill the fields manually.");
        }
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  async function onUpload(file: File) {
    setBusy("upload");
    setMsg(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/admin/account/brand/upload", { method: "POST", body: fd });
      const data = (await res.json().catch(() => ({}))) as { pdfPath?: string; pdfName?: string; message?: string };
      if (res.ok && data.pdfPath) {
        setPdfPath(data.pdfPath);
        setPdfName(data.pdfName ?? file.name);
        await onExtract(data.pdfPath, data.pdfName ?? file.name);
      } else {
        setMsg(data.message ?? "Upload failed.");
      }
    } finally {
      setBusy(null);
    }
  }

  async function onSave() {
    setBusy("save");
    setMsg(null);
    const payload: BrandKit = {
      ...kit,
      pdfPath,
      pdfName,
      fonts: lines(fontsText),
      dos: lines(dosText),
      donts: lines(dontsText),
    };
    try {
      const res = await fetch("/api/admin/account/brand", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setMsg(res.ok ? "Saved." : "Save failed.");
      if (res.ok) setColorsDirty(false);
    } finally {
      setBusy(null);
    }
  }

  const busyLabel = busy === "upload" ? "Uploading…" : busy === "extract" ? "Extracting…" : null;

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Brand</h2>
        <p className={HINT}>
          Upload your brand guidelines (PDF) and we&apos;ll extract a brand kit to keep AI-generated
          emails and images on-brand. You can edit anything below.
        </p>
      </div>

      {/* Upload */}
      <div className="rounded-md border border-dashed border-neutral-300 p-4 dark:border-neutral-700">
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onUpload(f);
            e.target.value = "";
          }}
        />
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy !== null}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60 dark:bg-white dark:text-neutral-900"
          >
            {busyLabel ?? (pdfName ? "Replace PDF" : "Upload brand guidelines (PDF)")}
          </button>
          {pdfName ? <span className="text-sm text-neutral-600 dark:text-neutral-300">📄 {pdfName}</span> : null}
          {pdfPath ? (
            <button
              type="button"
              onClick={() => onExtract(pdfPath, pdfName)}
              disabled={busy !== null}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-60 dark:border-neutral-700"
            >
              Re-extract
            </button>
          ) : null}
        </div>
        <p className={`mt-2 ${HINT}`}>PDF only, up to 14MB.</p>
      </div>

      {/* Extracted / editable fields */}
      <Field label="Summary" hint="A short brand overview.">
        <textarea rows={3} className={INPUT} value={kit.summary ?? ""} onChange={(e) => setKit((k) => ({ ...k, summary: e.target.value }))} />
      </Field>

      <div>
        <div className={LABEL}>Colours</div>
        <div className={HINT}>Your brand palette. Build it from a PDF, your website, a logo, or an AI theme — review, then keep.</div>
        <div className="mt-2">
          <BrandColours
            palette={kit.palette ?? []}
            palettes={kit.palettes ?? []}
            pdfPath={pdfPath}
            onChange={({ palette, palettes }) => {
              setKit((k) => ({ ...k, palette, palettes }));
              setColorsDirty(true);
            }}
          />
        </div>
      </div>

      <Field label="Fonts" hint="One per line.">
        <textarea rows={2} className={INPUT} value={fontsText} onChange={(e) => setFontsText(e.target.value)} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Tone">
          <textarea rows={2} className={INPUT} value={kit.tone ?? ""} onChange={(e) => setKit((k) => ({ ...k, tone: e.target.value }))} />
        </Field>
        <Field label="Voice">
          <textarea rows={2} className={INPUT} value={kit.voice ?? ""} onChange={(e) => setKit((k) => ({ ...k, voice: e.target.value }))} />
        </Field>
      </div>
      <Field label="Imagery style" hint="Photography / illustration direction — used for image generation.">
        <textarea rows={2} className={INPUT} value={kit.imageryStyle ?? ""} onChange={(e) => setKit((k) => ({ ...k, imageryStyle: e.target.value }))} />
      </Field>
      <Field label="Logo usage">
        <textarea rows={2} className={INPUT} value={kit.logoUsage ?? ""} onChange={(e) => setKit((k) => ({ ...k, logoUsage: e.target.value }))} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Do's" hint="One per line.">
          <textarea rows={4} className={INPUT} value={dosText} onChange={(e) => setDosText(e.target.value)} />
        </Field>
        <Field label="Don'ts" hint="One per line.">
          <textarea rows={4} className={INPUT} value={dontsText} onChange={(e) => setDontsText(e.target.value)} />
        </Field>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onSave}
          disabled={busy !== null}
          className="rounded-md bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-60 dark:bg-white dark:text-neutral-900"
        >
          {busy === "save" ? "Saving…" : "Save brand kit"}
        </button>
        {colorsDirty ? (
          <span className="text-sm text-amber-600 dark:text-amber-400">
            Unsaved colour changes — Save to keep them.
          </span>
        ) : msg ? (
          <span className="text-sm text-neutral-500">{msg}</span>
        ) : null}
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className={LABEL}>{label}</div>
      {hint ? <div className={HINT}>{hint}</div> : null}
      {children}
    </div>
  );
}

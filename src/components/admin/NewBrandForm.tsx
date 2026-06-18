"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Region } from "@/lib/types/tenant";

const REGIONS: { value: Region; label: string }[] = [
  { value: "us", label: "United States" },
  { value: "eu", label: "Europe" },
  { value: "asia", label: "Asia" },
];

/**
 * Minimal "create a brand" form: capture the name, root domain, and data region
 * and POST to /api/admin/tenants. On success the caller is auto-switched into
 * the new brand (cookie set server-side), so we jump back to the dashboard.
 * Mirrors NewLaunchForm's structure.
 */
export function NewBrandForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [region, setRegion] = useState<Region>("us");
  const [status, setStatus] = useState<"idle" | "creating" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Brand name is required.");
      setStatus("error");
      return;
    }
    if (!domain.trim()) {
      setError("Root domain is required.");
      setStatus("error");
      return;
    }
    setStatus("creating");
    setError(null);

    const res = await fetch("/api/admin/tenants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), rootDomain: domain.trim(), region }),
    });

    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as {
        message?: string;
        error?: string;
      };
      setError(data.message ?? data.error ?? "Could not create the brand. Please try again.");
      setStatus("error");
      return;
    }

    router.push("/admin");
    router.refresh();
  }

  const busy = status === "creating";

  return (
    <form onSubmit={submit} className="space-y-5">
      <Field label="Brand name" hint="Shown in the brand switcher and across the workspace.">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Acme Inc."
          required
          className={inputClass}
        />
      </Field>

      <Field
        label="Root domain"
        hint="Used for the brand favicon and signup origins, e.g. acme.com."
      >
        <input
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          placeholder="acme.com"
          required
          className={inputClass}
        />
      </Field>

      <Field label="Data region" hint="Where this brand's data lives. It cannot be changed later.">
        <select
          value={region}
          onChange={(e) => setRegion(e.target.value as Region)}
          className={inputClass}
        >
          {REGIONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </Field>

      {error ? (
        <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-60 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {busy ? "Creating…" : "Create brand"}
        </button>
        <span className="text-xs text-neutral-400">
          You will be switched into the new brand automatically.
        </span>
      </div>
    </form>
  );
}

const inputClass =
  "w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint ? <span className="block text-xs text-neutral-400">{hint}</span> : null}
    </label>
  );
}

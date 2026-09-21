"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Route } from "lucide-react";
import { api, errorText, timeAgo } from "../connect/api";
import { Badge, Banner, Button, Field, Section, inputClass } from "../connect/ui";

/** Lifecycle → Journeys: every journey, and starting a new one on a connected product. */

interface JourneySummary {
  id: string;
  name: string;
  connectionId: string;
  connectionName: string | null;
  status: "draft" | "active" | "paused" | "archived";
  deliveryMode: "test" | "shadow" | "live";
  publishedVersion: number | null;
  authoredBy: "human" | "agent";
  updatedAt: string;
}

interface ConnectionOption {
  id: string;
  name: string;
  kind: "custom" | "sandbox";
  stepCount: number;
}

export function JourneysHome({ canEdit }: { canEdit: boolean }) {
  const router = useRouter();
  const [journeys, setJourneys] = useState<JourneySummary[] | null>(null);
  const [connections, setConnections] = useState<ConnectionOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "Post-signup onboarding", connectionId: "", template: "product_onboarding" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await api<{ journeys: JourneySummary[]; connections: ConnectionOption[] }>("/api/admin/lifecycle/journeys");
    if (!r.ok) return setError(errorText(r.data));
    setError(null);
    setJourneys(r.data.journeys);
    setConnections(r.data.connections);
    setForm((f) => (f.connectionId ? f : { ...f, connectionId: r.data.connections[0]?.id ?? "" }));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    const r = await api<{ journey: { id: string } }>("/api/admin/lifecycle/journeys", { method: "POST", body: JSON.stringify(form) });
    setBusy(false);
    if (!r.ok) return setError(errorText(r.data));
    router.push(`/admin/lifecycle/${r.data.journey.id}`);
  };

  const selected = connections.find((c) => c.id === form.connectionId);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Journeys</h1>
          <p className="max-w-2xl text-sm text-neutral-500 dark:text-neutral-400">
            Email sequences that follow each of your users through your product — nudging people who haven&rsquo;t finished
            onboarding, and teaching the ones who have.
          </p>
        </div>
        {canEdit ? (
          <Button tone="primary" disabled={connections.length === 0} onClick={() => setCreating(true)}>
            <Plus size={14} /> New journey
          </Button>
        ) : null}
      </div>

      {error ? <Banner tone="err">{error}</Banner> : null}
      {connections.length === 0 && journeys !== null ? (
        <Banner tone="info">
          Connect a product (or create a sandbox) on the{" "}
          <Link className="underline" href="/admin/products">
            Products
          </Link>{" "}
          page first — journeys are built on what your product tells us.
        </Banner>
      ) : null}

      {creating ? (
        <Section title="New journey" description="Starts as a draft in test mode. Nothing sends until you publish.">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Name">
              <input className={inputClass} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Product">
              <select className={inputClass} value={form.connectionId} onChange={(e) => setForm({ ...form, connectionId: e.target.value })}>
                {connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.kind === "sandbox" ? " (sandbox)" : ""}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Start from">
              <select className={inputClass} value={form.template} onChange={(e) => setForm({ ...form, template: e.target.value })}>
                <option value="product_onboarding">7-day onboarding (splits on progress)</option>
                <option value="blank">Blank canvas</option>
              </select>
            </Field>
          </div>
          {form.template === "product_onboarding" && selected && selected.stepCount === 0 ? (
            <Banner tone="info">This product has no onboarding steps in its catalog yet — add them on its Products page so the journey can split on progress.</Banner>
          ) : null}
          <div className="flex gap-2">
            <Button tone="primary" disabled={busy || !form.name.trim() || !form.connectionId} onClick={() => void create()}>
              {busy ? "Creating…" : "Create draft"}
            </Button>
            <Button onClick={() => setCreating(false)}>Cancel</Button>
          </div>
        </Section>
      ) : null}

      {journeys === null && !error ? <p className="text-sm text-neutral-500">Loading…</p> : null}
      {journeys?.length === 0 && connections.length > 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 p-8 text-center dark:border-neutral-700">
          <Route className="mx-auto text-neutral-400" size={24} />
          <p className="mt-2 text-sm font-medium">No journeys yet</p>
          <p className="text-sm text-neutral-500">Start from the 7-day onboarding template and adjust it on the canvas.</p>
        </div>
      ) : null}
      {journeys && journeys.length > 0 ? (
        <ul className="grid gap-3 sm:grid-cols-2">
          {journeys.map((j) => (
            <li key={j.id}>
              <Link
                href={`/admin/lifecycle/${j.id}`}
                className="block space-y-2 rounded-lg border border-neutral-200 p-4 hover:border-neutral-400 dark:border-neutral-800 dark:hover:border-neutral-600"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-semibold">{j.name}</span>
                  <span className="flex gap-1">
                    <Badge tone={j.status === "active" ? "green" : j.status === "paused" ? "amber" : "neutral"}>{j.status}</Badge>
                    <Badge tone={j.deliveryMode === "live" ? "green" : "amber"}>{j.deliveryMode}</Badge>
                  </span>
                </div>
                <p className="text-xs text-neutral-500">
                  {j.connectionName ?? "Removed product"} · {j.publishedVersion ? `v${j.publishedVersion}` : "not published"} · edited{" "}
                  {timeAgo(j.updatedAt)}
                  {j.authoredBy === "agent" ? " · drafted with Vizzy" : ""}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

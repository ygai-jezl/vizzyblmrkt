"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Route } from "lucide-react";
import { WAITLIST_STATUS_LABEL, type WaitlistJourneyRow } from "@/lib/journey/waitlistJourneyRows";
import { api, errorText, timeAgo } from "../connect/api";
import { Badge, Banner, Button, Field, Section, inputClass } from "../connect/ui";

/**
 * Journeys: every journey, and starting a new one. Before nav v2 phase 3 these
 * are the lifecycle (product) journeys only. With phase 3 the page passes
 * `waitlist` too, and this becomes the one list of automated email — each card
 * says who enters it, and "New journey" asks that first.
 */

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

type Filter = "all" | "waitlist" | "product";

const CARD =
  "block space-y-2 rounded-lg border border-neutral-200 p-4 hover:border-neutral-400 dark:border-neutral-800 dark:hover:border-neutral-600";

function WhoChip({ kind, children }: { kind: "waitlist" | "product"; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex max-w-full items-center truncate rounded-full px-2 py-0.5 text-[11px] font-medium ${
        kind === "waitlist"
          ? "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300"
          : "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300"
      }`}
    >
      {children}
    </span>
  );
}

export function JourneysHome({
  canEdit,
  lifecycle = true,
  waitlist,
}: {
  canEdit: boolean;
  /** Product (lifecycle) journeys exist in this environment. */
  lifecycle?: boolean;
  /** Nav v2 phase 3: every launch's welcome journey, listed alongside. */
  waitlist?: WaitlistJourneyRow[];
}) {
  const router = useRouter();
  const unified = waitlist !== undefined;
  const [journeys, setJourneys] = useState<JourneySummary[] | null>(null);
  const [connections, setConnections] = useState<ConnectionOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [who, setWho] = useState<"waitlist" | "product" | null>(null);
  const [launchId, setLaunchId] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [form, setForm] = useState({ name: "Post-signup onboarding", connectionId: "", template: "product_onboarding" });
  const [busy, setBusy] = useState(false);
  const [importDoc, setImportDoc] = useState<unknown>(null);

  const load = useCallback(async () => {
    if (!lifecycle) {
      setJourneys([]);
      return;
    }
    const r = await api<{ journeys: JourneySummary[]; connections: ConnectionOption[] }>("/api/admin/lifecycle/journeys");
    if (!r.ok) return setError(errorText(r.data));
    setError(null);
    setJourneys(r.data.journeys);
    setConnections(r.data.connections);
    setForm((f) => (f.connectionId ? f : { ...f, connectionId: r.data.connections[0]?.id ?? "" }));
  }, [lifecycle]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    if (form.template === "import") {
      const r = await api<{ journeyId: string }>("/api/admin/lifecycle/journeys/import", {
        method: "POST",
        body: JSON.stringify({ connectionId: form.connectionId, name: form.name, document: importDoc }),
      });
      setBusy(false);
      if (!r.ok) return setError(errorText(r.data));
      return router.push(`/admin/lifecycle/${r.data.journeyId}`);
    }
    const r = await api<{ journey: { id: string } }>("/api/admin/lifecycle/journeys", { method: "POST", body: JSON.stringify(form) });
    setBusy(false);
    if (!r.ok) return setError(errorText(r.data));
    router.push(`/admin/lifecycle/${r.data.journey.id}`);
  };

  /** Read a downloaded journey file (…journey.json) in the browser; the server validates it. */
  const pickFile = async (file: File | undefined) => {
    setImportDoc(null);
    if (!file) return;
    if (file.size > 512 * 1024) return setError("That file is too large to be a journey.");
    try {
      const doc = JSON.parse(await file.text()) as { name?: unknown };
      setImportDoc(doc);
      if (typeof doc.name === "string") setForm((f) => ({ ...f, name: doc.name as string }));
      setError(null);
    } catch {
      setError("That file isn't a journey file (it isn't valid JSON).");
    }
  };

  const selected = connections.find((c) => c.id === form.connectionId);
  const openLaunches = (waitlist ?? []).filter((w) => !w.archived);
  const canStart = unified ? openLaunches.length > 0 || connections.length > 0 : connections.length > 0;
  const startNew = () => {
    setCreating(true);
    // Only one kind available? Skip the question.
    setWho(unified ? (connections.length === 0 ? "waitlist" : openLaunches.length === 0 ? "product" : null) : "product");
    setLaunchId((id) => id || openLaunches[0]?.campaignId || "");
  };
  const stopNew = () => {
    setCreating(false);
    setWho(null);
  };

  const productForm = (
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
            <option value="import">Import a journey file</option>
          </select>
        </Field>
      </div>
      {form.template === "import" ? (
        <Field label="Journey file" hint="A .journey.json downloaded from any journey (yours or another account's). It becomes a draft on this product.">
          <input type="file" accept="application/json,.json" className="text-sm" onChange={(e) => void pickFile(e.target.files?.[0])} />
        </Field>
      ) : null}
      {form.template === "product_onboarding" && selected && selected.stepCount === 0 ? (
        <Banner tone="info">This product has no onboarding steps in its catalog yet — add them on its Products page so the journey can split on progress.</Banner>
      ) : null}
      <div className="flex gap-2">
        <Button
          tone="primary"
          disabled={busy || !form.name.trim() || !form.connectionId || (form.template === "import" && !importDoc)}
          onClick={() => void create()}
        >
          {busy ? "Creating…" : "Create draft"}
        </Button>
        <Button onClick={stopNew}>Cancel</Button>
      </div>
    </Section>
  );

  const showWaitlist = unified && filter !== "product";
  const showProduct = filter !== "waitlist";
  const waitlistCount = waitlist?.length ?? 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Journeys</h1>
          <p className="max-w-2xl text-sm text-neutral-500 dark:text-neutral-400">
            {unified
              ? "Every automated email, whoever it's for: people who join a waitlist, and the users of your product."
              : "Email sequences that follow each of your users through your product — nudging people who haven’t finished onboarding, and teaching the ones who have."}
          </p>
        </div>
        {canEdit ? (
          <Button tone="primary" disabled={!canStart} onClick={startNew}>
            <Plus size={14} /> New journey
          </Button>
        ) : null}
      </div>

      {error ? <Banner tone="err">{error}</Banner> : null}
      {lifecycle && connections.length === 0 && journeys !== null ? (
        <Banner tone="info">
          {unified ? "Product journeys start from events in your app. " : null}Connect a product (or create a sandbox) on the{" "}
          <Link className="underline" href="/admin/products">
            Products
          </Link>{" "}
          page first — journeys are built on what your product tells us.
        </Banner>
      ) : null}

      {creating && unified && who === null ? (
        <Section title="New journey" description="Who enters it?">
          <div className="grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => setWho("waitlist")}
              className="space-y-1 rounded-lg border border-neutral-200 p-4 text-left hover:border-neutral-400 dark:border-neutral-800"
            >
              <WhoChip kind="waitlist">Waitlist</WhoChip>
              <p className="text-sm font-semibold">People who join a waitlist</p>
              <p className="text-xs text-neutral-500">Welcome and nurture emails for a launch&rsquo;s signups.</p>
            </button>
            <button
              type="button"
              onClick={() => setWho("product")}
              disabled={!lifecycle || connections.length === 0}
              className="space-y-1 rounded-lg border border-neutral-200 p-4 text-left hover:border-neutral-400 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-800"
            >
              <WhoChip kind="product">Product</WhoChip>
              <p className="text-sm font-semibold">Users of a connected product</p>
              <p className="text-xs text-neutral-500">
                {lifecycle && connections.length
                  ? "Onboarding that follows each user's progress in your app."
                  : "Connect a product first."}
              </p>
            </button>
          </div>
          <div>
            <Button onClick={stopNew}>Cancel</Button>
          </div>
        </Section>
      ) : null}

      {creating && who === "waitlist" ? (
        <Section
          title="New waitlist journey"
          description="Each launch has one welcome & nurture journey. You edit it on the launch, then publish it."
        >
          <Field label="Launch">
            <select className={inputClass} value={launchId} onChange={(e) => setLaunchId(e.target.value)}>
              {openLaunches.map((w) => (
                <option key={w.campaignId} value={w.campaignId}>
                  {w.launchName} · {WAITLIST_STATUS_LABEL[w.status].toLowerCase()}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex gap-2">
            <Button tone="primary" disabled={!launchId} onClick={() => router.push(`/admin/launches/${launchId}/journey`)}>
              Open journey
            </Button>
            <Button onClick={stopNew}>Cancel</Button>
          </div>
        </Section>
      ) : null}

      {creating && who === "product" ? productForm : null}

      {unified ? (
        <div className="flex flex-wrap gap-2 text-sm" role="group" aria-label="Show">
          {(
            [
              ["all", `All · ${waitlistCount + (journeys?.length ?? 0)}`],
              ["waitlist", `Waitlist · ${waitlistCount}`],
              ["product", `Product · ${journeys?.length ?? 0}`],
            ] as Array<[Filter, string]>
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
              className={`rounded-full border px-3 py-1 ${
                filter === id
                  ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                  : "border-neutral-300 dark:border-neutral-700"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}

      {journeys === null && !error ? <p className="text-sm text-neutral-500">Loading…</p> : null}
      {!unified && journeys?.length === 0 && connections.length > 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 p-8 text-center dark:border-neutral-700">
          <Route className="mx-auto text-neutral-400" size={24} />
          <p className="mt-2 text-sm font-medium">No journeys yet</p>
          <p className="text-sm text-neutral-500">Start from the 7-day onboarding template and adjust it on the canvas.</p>
        </div>
      ) : null}

      <ul className="grid gap-3 sm:grid-cols-2">
        {showWaitlist
          ? waitlist!.map((w) => (
              <li key={`w:${w.campaignId}`}>
                <Link href={w.href} className={CARD}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-semibold">Welcome &amp; nurture</span>
                    <Badge tone={w.status === "active" ? "green" : w.status === "paused" ? "amber" : "neutral"}>
                      {WAITLIST_STATUS_LABEL[w.status]}
                    </Badge>
                  </div>
                  <WhoChip kind="waitlist">
                    Waitlist · {w.launchName}
                    {w.archived ? " (archived)" : ""}
                  </WhoChip>
                  <p className="text-xs text-neutral-500">
                    {w.emails ? `${w.emails} email${w.emails === 1 ? "" : "s"}` : "No emails yet"}
                    {w.updatedAt ? ` · edited ${timeAgo(w.updatedAt)}` : ""}
                  </p>
                </Link>
              </li>
            ))
          : null}
        {showProduct && journeys
          ? journeys.map((j) => (
              <li key={j.id}>
                <Link href={`/admin/lifecycle/${j.id}`} className={CARD}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-semibold">{j.name}</span>
                    <span className="flex gap-1">
                      <Badge tone={j.status === "active" ? "green" : j.status === "paused" ? "amber" : "neutral"}>{j.status}</Badge>
                      <Badge tone={j.deliveryMode === "live" ? "green" : "amber"}>{j.deliveryMode}</Badge>
                    </span>
                  </div>
                  {unified ? <WhoChip kind="product">Product · {j.connectionName ?? "Removed product"}</WhoChip> : null}
                  <p className="text-xs text-neutral-500">
                    {unified ? null : <>{j.connectionName ?? "Removed product"} · </>}
                    {j.publishedVersion ? `v${j.publishedVersion}` : "not published"} · edited {timeAgo(j.updatedAt)}
                    {j.authoredBy === "agent" ? " · drafted with Vizzy" : ""}
                  </p>
                </Link>
              </li>
            ))
          : null}
      </ul>
    </div>
  );
}

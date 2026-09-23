"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { FlaskConical, Plug, Plus } from "lucide-react";
import { ENVIRONMENT_LABEL, groupProducts, type ProductGroup } from "@/lib/connect/environments";
import { isNavV2Phase3Enabled } from "@/lib/nav/flags";
import { api, errorText, timeAgo, type PublicConnection } from "./api";
import { SetupWizard } from "./SetupWizard";
import { Badge, Banner, Button } from "./ui";

const PHASE3 = isNavV2Phase3Enabled();

function ConnectionRow({ c, label }: { c: PublicConnection; label: string }) {
  return (
    <Link
      href={`/admin/products/${c.id}`}
      className="flex items-center justify-between gap-3 rounded-md px-3 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-900"
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block truncate text-xs text-neutral-500">
          Last event {timeAgo(c.health?.lastEventAt)} · {c.catalog.onboardingSteps.length} onboarding steps
        </span>
      </span>
      <Badge tone={c.status === "active" ? "green" : c.status === "paused" ? "amber" : "red"}>{c.status}</Badge>
    </Link>
  );
}

/** Nav v2 phase 3: a product with its staging and production connections together. */
function ProductCard({ group, onConnect }: { group: ProductGroup<PublicConnection>; onConnect?: (env: "production" | "staging") => void }) {
  const rows = [
    ...group.staging.map((c) => ({ c, label: ENVIRONMENT_LABEL.staging })),
    ...group.production.map((c) => ({ c, label: ENVIRONMENT_LABEL.production })),
    ...group.other.map((c) => ({ c, label: c.name })),
  ];
  const missing = group.staging.length && !group.production.length ? "production" : group.production.length && !group.staging.length ? "staging" : null;
  return (
    <li className="space-y-1 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
      <p className="px-3 pt-1 text-sm font-semibold">{group.product}</p>
      {rows.map(({ c, label }) => (
        <ConnectionRow key={c.id} c={c} label={label} />
      ))}
      {missing && onConnect ? (
        <button
          type="button"
          onClick={() => onConnect(missing)}
          className="mx-3 mb-1 text-xs font-medium text-blue-700 hover:underline dark:text-blue-300"
        >
          + Connect {ENVIRONMENT_LABEL[missing]}
        </button>
      ) : null}
    </li>
  );
}

/** Products: the tenant's connected products and sandboxes. */
export function ProductsHome({ canEdit }: { canEdit: boolean }) {
  const [connections, setConnections] = useState<PublicConnection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wizard, setWizard] = useState<"custom" | "sandbox" | null>(null);
  const [preset, setPreset] = useState<{ name: string; environment: "staging" | "production" } | null>(null);

  const load = useCallback(async () => {
    const r = await api<{ connections: PublicConnection[] }>("/api/admin/connections");
    if (!r.ok) return setError(errorText(r.data));
    setError(null);
    setConnections(r.data.connections);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Products</h1>
          <p className="max-w-2xl text-sm text-neutral-500 dark:text-neutral-400">
            Connect your product so lifecycle journeys know who your users are and where they are
            in onboarding. Try it with a sandbox first — no code needed.
          </p>
        </div>
        {canEdit ? (
          <div className="flex gap-2">
            <Button onClick={() => setWizard("sandbox")}>
              <FlaskConical size={14} /> Create sandbox
            </Button>
            <Button tone="primary" onClick={() => setWizard("custom")}>
              <Plus size={14} /> Connect a product
            </Button>
          </div>
        ) : null}
      </div>

      {error ? <Banner tone="err">{error}</Banner> : null}

      {connections === null && !error ? <p className="text-sm text-neutral-500">Loading…</p> : null}
      {connections?.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 p-8 text-center dark:border-neutral-700">
          <Plug className="mx-auto text-neutral-400" size={24} />
          <p className="mt-2 text-sm font-medium">No products connected yet</p>
          <p className="text-sm text-neutral-500">Start with a sandbox to see the whole flow end to end.</p>
        </div>
      ) : null}

      {PHASE3 && connections && connections.length > 0 ? (
        (() => {
          const { products, sandboxes } = groupProducts(connections);
          return (
            <div className="space-y-4">
              {products.length ? (
                <ul className="grid gap-3 sm:grid-cols-2">
                  {products.map((g) => (
                    <ProductCard
                      key={g.key}
                      group={g}
                      onConnect={
                        canEdit
                          ? (environment) => {
                              setPreset({ name: g.product, environment });
                              setWizard("custom");
                            }
                          : undefined
                      }
                    />
                  ))}
                </ul>
              ) : null}
              {sandboxes.length ? (
                <div className="space-y-2">
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">Sandboxes</h2>
                  <ul className="grid gap-3 sm:grid-cols-2">
                    {sandboxes.map((c) => (
                      <li key={c.id} className="rounded-lg border border-neutral-200 p-1 dark:border-neutral-800">
                        <ConnectionRow c={c} label={c.name} />
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          );
        })()
      ) : null}

      {!PHASE3 && connections && connections.length > 0 ? (
        <ul className="grid gap-3 sm:grid-cols-2">
          {connections.map((c) => (
            <li key={c.id}>
              <Link
                href={`/admin/products/${c.id}`}
                className="block space-y-2 rounded-lg border border-neutral-200 p-4 hover:border-neutral-400 dark:border-neutral-800 dark:hover:border-neutral-600"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-semibold">{c.name}</span>
                  <span className="flex gap-1">
                    {c.kind === "sandbox" ? <Badge tone="amber">Sandbox</Badge> : null}
                    <Badge tone={c.status === "active" ? "green" : c.status === "paused" ? "amber" : "red"}>
                      {c.status}
                    </Badge>
                  </span>
                </div>
                <p className="truncate font-mono text-xs text-neutral-500">{c.keyId}</p>
                <p className="text-xs text-neutral-500">
                  Last event {timeAgo(c.health?.lastEventAt)} · {c.catalog.onboardingSteps.length} onboarding steps
                </p>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}

      <SetupWizard
        open={wizard !== null}
        kind={wizard ?? "custom"}
        preset={preset}
        onClose={() => {
          setWizard(null);
          setPreset(null);
        }}
        onCreated={() => void load()}
      />
    </div>
  );
}

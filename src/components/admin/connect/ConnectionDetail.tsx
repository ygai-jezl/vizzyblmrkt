"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { api, errorText, timeAgo, type ConnectionDiagnostics, type PublicConnection } from "./api";
import { EventDebugger } from "./EventDebugger";
import { UsersTable } from "./UsersTable";
import { ContextTester } from "./ContextTester";
import { CatalogEditor } from "./CatalogEditor";
import { LearnFromRepo } from "./LearnFromRepo";
import { IntegrationGuide } from "./IntegrationGuide";
import { SandboxPanel } from "./SandboxPanel";
import { ConnectionSettings } from "./ConnectionSettings";
import { SetupPanel } from "./SetupPanel";
import { Badge, Banner, Tabs } from "./ui";
import { ENVIRONMENT_LABEL, environmentOf } from "@/lib/connect/environments";
import { isNavV2Phase3Enabled } from "@/lib/nav/flags";

type Tab = "setup" | "sandbox" | "events" | "users" | "test" | "learn" | "catalog" | "guide" | "settings";

// Nav v2 phase 3: a Setup checklist opens real products (sandboxes keep their own tab).
const PHASE3 = isNavV2Phase3Enabled();

/** One connected product: debugger, users, context test, catalog, settings. */
export function ConnectionDetail({ connectionId, canEdit }: { connectionId: string; canEdit: boolean }) {
  const [connection, setConnection] = useState<PublicConnection | null>(null);
  const [diagnostics, setDiagnostics] = useState<ConnectionDiagnostics | null>(null);
  /** API v2 entities are on (CONNECT_ENTITIES_ENABLED): the catalog can name them. */
  const [entities, setEntities] = useState(false);
  /** Catalog history is on (CATALOG_HISTORY_ENABLED). */
  const [catalogHistory, setCatalogHistory] = useState(false);
  /** The Catalog tab has unsaved edits. */
  const [catalogDirty, setCatalogDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab | null>(null);

  const load = useCallback(async () => {
    const r = await api<{
      connection: PublicConnection;
      diagnostics: ConnectionDiagnostics | null;
      features?: { entities?: boolean; catalogHistory?: boolean };
    }>(
      `/api/admin/connections/${connectionId}`,
    );
    if (!r.ok) return setError(errorText(r.data));
    setError(null);
    setConnection(r.data.connection);
    setDiagnostics(r.data.diagnostics);
    setEntities(Boolean(r.data.features?.entities));
    setCatalogHistory(Boolean(r.data.features?.catalogHistory));
    // ?tab=learn (etc.) opens a tab directly — e.g. from the setup wizard.
    const asked = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("tab") : null;
    const valid: Tab[] = ["setup", "sandbox", "events", "users", "test", "learn", "catalog", "guide", "settings"];
    const fromUrl = valid.find((v) => v === asked && (v !== "setup" || PHASE3)) ?? null;
    const fallback: Tab = r.data.connection.kind === "sandbox" ? "sandbox" : PHASE3 ? "setup" : "events";
    setTab((t) => t ?? fromUrl ?? fallback);
  }, [connectionId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Coming back to a page left open on the Catalog tab fetches the latest catalog.
  useEffect(() => {
    if (tab !== "catalog") return;
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [tab, load]);

  /** Switch tab: the Catalog tab opens on the latest catalog, and leaving it with unsaved edits asks first. */
  const openTab = useCallback(
    (next: Tab) => {
      if (tab === "catalog" && next !== "catalog" && catalogDirty && !window.confirm("Leave the catalog? Your unsaved edits will be lost.")) return;
      if (next === "catalog" && tab !== "catalog") void load();
      setTab(next);
    },
    [tab, catalogDirty, load],
  );

  if (error) return <Banner tone="err">{error}</Banner>;
  if (!connection || !tab) return <p className="text-sm text-neutral-500">Loading…</p>;

  const tabs: Array<{ id: Tab; label: string }> = [
    ...(PHASE3 && connection.kind === "custom" ? [{ id: "setup" as const, label: "Setup" }] : []),
    ...(connection.kind === "sandbox" ? [{ id: "sandbox" as const, label: "Sandbox" }] : []),
    { id: "events", label: "Events" },
    { id: "users", label: "Users" },
    { id: "test", label: "Test connection" },
    ...(connection.kind === "custom" ? [{ id: "learn" as const, label: "Learn from repo" }] : []),
    { id: "catalog", label: "Catalog" },
    ...(connection.kind === "custom" ? [{ id: "guide" as const, label: "Integration guide" }] : []),
    { id: "settings", label: "Settings" },
  ];
  const h = connection.health ?? {};
  const env = PHASE3 && connection.kind === "custom" ? environmentOf(connection) : null;

  return (
    <div className="space-y-4">
      <Link href="/admin/products" className="inline-flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-800">
        <ArrowLeft size={12} /> Products
      </Link>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold">{connection.name}</h1>
        {connection.kind === "sandbox" ? <Badge tone="amber">Sandbox</Badge> : null}
        {env ? <Badge tone={env === "production" ? "green" : "neutral"}>{ENVIRONMENT_LABEL[env]}</Badge> : null}
        <Badge tone={connection.status === "active" ? "green" : connection.status === "paused" ? "amber" : "red"}>
          {connection.status}
        </Badge>
      </div>
      <p className="text-xs text-neutral-500">
        <span className="font-mono">{connection.keyId}</span> · last event {timeAgo(h.lastEventAt)} · context{" "}
        {h.lastContextError
          ? `failing (${h.lastContextError}, ${h.consecutiveContextFailures ?? 0}× in a row)`
          : h.lastContextOkAt
            ? `ok ${timeAgo(h.lastContextOkAt)}`
            : "not tested yet"}
      </p>

      <Tabs tabs={tabs} value={tab} onChange={openTab} />

      {tab === "setup" ? <SetupPanel connection={connection} onOpenTab={openTab} /> : null}
      {tab === "sandbox" ? <SandboxPanel connection={connection} canEdit={canEdit} onChanged={() => void load()} /> : null}
      {tab === "events" ? <EventDebugger connectionId={connection.id} /> : null}
      {tab === "users" ? <UsersTable connection={connection} canEdit={canEdit} onOpenCatalog={() => openTab("catalog")} /> : null}
      {tab === "test" ? <ContextTester connection={connection} canEdit={canEdit} /> : null}
      {tab === "learn" ? (
        <LearnFromRepo
          connection={connection}
          canEdit={canEdit}
          onOpenCatalog={() => openTab("catalog")}
          onAccepted={async () => {
            // Open the Catalog only once it has what was just added.
            await load();
            setTab("catalog");
          }}
        />
      ) : null}
      {tab === "catalog" ? (
        <CatalogEditor
          connection={connection}
          diagnostics={diagnostics}
          canEdit={canEdit}
          entities={entities}
          history={catalogHistory}
          onDirtyChange={setCatalogDirty}
          onSaved={() => void load()}
        />
      ) : null}
      {tab === "guide" ? <IntegrationGuide connection={connection} /> : null}
      {tab === "settings" ? <ConnectionSettings connection={connection} canEdit={canEdit} onSaved={() => void load()} /> : null}
    </div>
  );
}

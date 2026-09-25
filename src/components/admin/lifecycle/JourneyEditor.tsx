"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Copy, Download, MessageSquare, Pause, Play, Rocket, Save, Sparkles } from "lucide-react";
import type { LifecycleDraft, LifecycleGraph, LifecycleJourney } from "@/lib/types/lifecycle";
import { api, errorText, timeAgo } from "../connect/api";
import { Badge, Banner, Button, Tabs, inputClass } from "../connect/ui";
import { LifecycleCanvas } from "./LifecycleCanvas";
import { PoolsEditor } from "./PoolsEditor";
import { SettingsPanel } from "./SettingsPanel";
import { DeliveryPanel } from "./DeliveryPanel";
import { EnrolmentsPanel } from "./EnrolmentsPanel";
import { TimelinePreview } from "./TimelinePreview";
import { AnalyticsPanel } from "./AnalyticsPanel";
import { GeneratePanel } from "./GeneratePanel";
import { CopyJourneyPanel } from "./CopyJourneyPanel";
import { LifecycleChatPanel } from "./LifecycleChatPanel";
import { fieldOptions, issueText, waitlistFieldOptions, type GraphIssue, type JourneyDetail } from "./model";

/**
 * One lifecycle journey: the canvas, its content, settings and delivery, the
 * people in it, a timeline preview and results. Edits change the DRAFT only;
 * nothing reaches anyone until an admin publishes. A launch's welcome journey
 * (engine move) is edited here too, in its waitlist mode: signup conditions,
 * waitlist merge tags, A/B tests and any-time sending.
 */

type Tab = "canvas" | "content" | "settings" | "delivery" | "people" | "preview" | "results";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "canvas", label: "Canvas" },
  { id: "content", label: "Content" },
  { id: "settings", label: "Settings" },
  { id: "delivery", label: "Delivery" },
  { id: "people", label: "People" },
  { id: "preview", label: "Timeline preview" },
  { id: "results", label: "Results" },
];

export function JourneyEditor({ journeyId, canEdit }: { journeyId: string; canEdit: boolean }) {
  const [detail, setDetail] = useState<JourneyDetail | null>(null);
  const [draft, setDraft] = useState<LifecycleDraft | null>(null);
  const [issues, setIssues] = useState<GraphIssue[]>([]);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<Tab>("canvas");
  const [canvasKey, setCanvasKey] = useState(0);
  const [focusPool, setFocusPool] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "err" | "info"; text: string } | null>(null);
  const [name, setName] = useState("");
  const [chatOpen, setChatOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [copying, setCopying] = useState(false);
  const [staleFromChat, setStaleFromChat] = useState(false);

  const load = useCallback(async () => {
    const r = await api<JourneyDetail>(`/api/admin/lifecycle/journeys/${journeyId}`);
    if (!r.ok) return setMsg({ tone: "err", text: errorText(r.data) });
    setDetail(r.data);
    setDraft(r.data.journey.draft);
    setIssues(r.data.issues);
    setName(r.data.journey.name);
    setDirty(false);
    setStaleFromChat(false);
    setCanvasKey((k) => k + 1);
  }, [journeyId]);

  // Vizzy saved a new draft of THIS journey: reload it, unless there are unsaved edits here.
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);
  const onChatSaved = useCallback(
    (card: { id: string }) => {
      if (card.id !== journeyId) return;
      if (dirtyRef.current) setStaleFromChat(true);
      else void load();
    },
    [journeyId, load],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [dirty]);

  const edit = useCallback((patch: Partial<LifecycleDraft>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
    setDirty(true);
  }, []);
  const onGraph = useCallback((graph: LifecycleGraph) => edit({ graph }), [edit]);

  const waitlist = detail?.audience === "waitlist";
  const fields = useMemo(
    () => (waitlist ? waitlistFieldOptions() : fieldOptions(detail?.connection?.catalog)),
    [waitlist, detail?.connection?.catalog],
  );
  const journey = detail?.journey;

  const save = async (): Promise<boolean> => {
    if (!draft || !journey) return false;
    setBusy("save");
    setMsg(null);
    const r = await api<{ journey: LifecycleJourney; issues: GraphIssue[] }>(`/api/admin/lifecycle/journeys/${journey.id}/draft`, {
      method: "PUT",
      body: JSON.stringify(draft),
    });
    setBusy(null);
    if (!r.ok) {
      setMsg({ tone: "err", text: errorText(r.data) });
      return false;
    }
    setIssues(r.data.issues);
    setDetail((d) => (d ? { ...d, journey: r.data.journey, issues: r.data.issues } : d));
    setDirty(false);
    setMsg({ tone: "ok", text: r.data.issues.length ? "Draft saved — fix the issues below before publishing." : "Draft saved." });
    return true;
  };

  const publish = async () => {
    if (!journey) return;
    if (dirty && !(await save())) return;
    if (!window.confirm(journey.publishedVersion ? "Publish these changes? People already in the journey stay on the version they started with." : `Publish and start the journey in ${journey.deliveryMode} mode?`)) return;
    setBusy("publish");
    const r = await api<{ journey: LifecycleJourney; version: { version: number } }>(`/api/admin/lifecycle/journeys/${journey.id}/publish`, { method: "POST" });
    setBusy(null);
    if (!r.ok) {
      const d = r.data as unknown as { error?: string; detail?: unknown };
      if (d.error === "invalid_journey" && Array.isArray(d.detail)) setIssues(d.detail as GraphIssue[]);
      return setMsg({ tone: "err", text: errorText({ error: d.error }) });
    }
    setMsg({ tone: "ok", text: `Published version ${r.data.version.version}.` });
    await load();
  };

  const setStatus = async (status: "active" | "paused" | "archived") => {
    if (!journey) return;
    if (status === "archived" && !window.confirm("Archive this journey? Everyone in it stops receiving its emails.")) return;
    setBusy("status");
    const r = await api(`/api/admin/lifecycle/journeys/${journey.id}/status`, { method: "POST", body: JSON.stringify({ status }) });
    setBusy(null);
    if (!r.ok) return setMsg({ tone: "err", text: errorText(r.data) });
    if (status === "archived") window.location.assign("/admin/lifecycle");
    else await load();
  };

  const rename = async () => {
    if (!journey || !name.trim() || name.trim() === journey.name) return;
    const r = await api<{ journey: LifecycleJourney }>(`/api/admin/lifecycle/journeys/${journey.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: name.trim() }),
    });
    if (!r.ok) setMsg({ tone: "err", text: errorText(r.data) });
    else setDetail((d) => (d ? { ...d, journey: { ...d.journey, name: r.data.journey.name } } : d));
  };

  if (!detail || !draft || !journey) {
    return msg ? <Banner tone={msg.tone}>{msg.text}</Banner> : <p className="text-sm text-neutral-500">Loading…</p>;
  }
  const readOnly = !canEdit;
  const connection = detail.connection;
  const launch = detail.launch;
  const tabs = waitlist ? TABS.filter((t) => t.id !== "preview") : TABS;

  return (
    <div className="space-y-4">
      <Link
        href={waitlist && launch ? `/admin/launches/${launch.id}/emails` : "/admin/lifecycle"}
        className="inline-flex items-center gap-1 text-sm text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
      >
        <ArrowLeft size={14} /> {waitlist ? "Emails" : "Journeys"}
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          {canEdit ? (
            <input
              className={`${inputClass} w-80 text-lg font-semibold`}
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, 120))}
              onBlur={() => void rename()}
              aria-label="Journey name"
            />
          ) : (
            <h1 className="text-lg font-semibold">{journey.name}</h1>
          )}
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-neutral-500">
            {waitlist ? (
              <span>
                welcome emails for{" "}
                {launch ? (
                  <Link className="underline" href={`/admin/launches/${launch.id}`}>
                    {launch.name}
                  </Link>
                ) : (
                  "a removed launch"
                )}
              </span>
            ) : (
              <span>
                for{" "}
                {connection ? (
                  <Link className="underline" href={`/admin/products/${connection.id}`}>
                    {connection.name}
                  </Link>
                ) : (
                  "a removed product"
                )}
              </span>
            )}
            <Badge tone={journey.status === "active" ? "green" : journey.status === "paused" ? "amber" : "neutral"}>{journey.status}</Badge>
            <Badge tone={journey.deliveryMode === "live" ? "green" : "amber"}>{journey.deliveryMode}</Badge>
            {detail.version ? (
              <span>
                v{detail.version.version} published {timeAgo(detail.version.publishedAt)}
              </span>
            ) : (
              <span>not published</span>
            )}
            {journey.authoredBy === "agent" ? <Badge>drafted with Vizzy</Badge> : null}
            {dirty ? <Badge tone="amber">unsaved changes</Badge> : null}
          </div>
        </div>
        {canEdit ? (
          <div className="flex flex-wrap gap-2">
            {detail.features.chatAuthoring ? (
              <Button onClick={() => setChatOpen(!chatOpen)}>
                <MessageSquare size={14} /> {chatOpen ? "Hide Vizzy" : "Ask Vizzy"}
              </Button>
            ) : null}
            {waitlist ? null : (
              <Button disabled={busy !== null || !connection} onClick={() => setGenerating(true)}>
                <Sparkles size={14} /> Generate
              </Button>
            )}
            <Button disabled={!dirty || busy !== null} onClick={() => void save()}>
              <Save size={14} /> {busy === "save" ? "Saving…" : "Save draft"}
            </Button>
            <Button tone="primary" disabled={busy !== null || (!connection && !waitlist)} onClick={() => void publish()}>
              <Rocket size={14} /> {busy === "publish" ? "Publishing…" : "Publish"}
            </Button>
            {journey.status === "active" ? (
              <Button disabled={busy !== null} onClick={() => void setStatus("paused")}>
                <Pause size={14} /> Pause
              </Button>
            ) : journey.status === "paused" ? (
              <Button disabled={busy !== null} onClick={() => void setStatus("active")}>
                <Play size={14} /> Resume
              </Button>
            ) : null}
            {waitlist ? null : (
              <Button disabled={busy !== null} onClick={() => setCopying(!copying)}>
                <Copy size={14} /> Copy to…
              </Button>
            )}
            <a
              className="inline-flex items-center gap-1 rounded-md border border-neutral-200 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"
              href={`/api/admin/lifecycle/journeys/${journey.id}/export?which=${journey.publishedVersion ? "published" : "draft"}`}
              download
              title="Download this journey as a file you can import into another product or account"
            >
              <Download size={14} /> Download
            </a>
            {waitlist ? null : (
              <Button tone="danger" disabled={busy !== null} onClick={() => void setStatus("archived")}>
                Archive
              </Button>
            )}
          </div>
        ) : null}
      </div>

      {msg ? <Banner tone={msg.tone}>{msg.text}</Banner> : null}
      {waitlist && journey.status === "paused" && detail.held ? (
        <Banner tone="info">
          {detail.held} {detail.held === 1 ? "person is" : "people are"} waiting while this is paused. They carry on when you resume it.
        </Banner>
      ) : null}
      {waitlist && launch?.archived ? <Banner tone="info">This launch is archived, so nothing is sent until it&rsquo;s restored.</Banner> : null}
      {staleFromChat ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          Vizzy saved a new version of this draft. Reloading shows it (your unsaved edits here will be lost).
          <Button onClick={() => void load()}>Reload</Button>
        </div>
      ) : null}
      {copying ? (
        <CopyJourneyPanel
          journeyId={journey.id}
          journeyName={journey.name}
          connectionId={journey.connectionId}
          published={Boolean(journey.publishedVersion)}
          onCancel={() => setCopying(false)}
        />
      ) : null}
      {generating ? (
        <GeneratePanel
          journeyId={journey.id}
          onCancel={() => setGenerating(false)}
          onDone={(notes) => {
            setGenerating(false);
            setMsg({
              tone: notes.length ? "info" : "ok",
              text: notes.length ? `Draft rebuilt — ${notes.join("; ")}.` : "Draft rebuilt with fresh copy. Review it, then publish.",
            });
            void load();
          }}
        />
      ) : null}
      {issues.length > 0 ? (
        <details className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300" open={issues.length <= 4}>
          <summary className="cursor-pointer font-medium">
            {issues.length} {issues.length === 1 ? "thing" : "things"} to fix before publishing
          </summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {issues.map((i, k) => (
              <li key={k}>{issueText(i)}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {connection && !connection.contextConfigured && connection.kind !== "sandbox" ? (
        <Banner tone="info">
          This product has no context endpoint yet, so emails can&rsquo;t include live facts or insights — conditions use
          the events it sends.
        </Banner>
      ) : null}

      <Tabs tabs={tabs} value={tab} onChange={setTab} />

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1 space-y-4">

      {tab === "canvas" ? (
        <LifecycleCanvas
          key={canvasKey}
          graph={draft.graph}
          pools={draft.pools}
          triggerEvent={draft.settings.trigger.event}
          fields={fields}
          issues={issues}
          readOnly={readOnly}
          waitlist={waitlist}
          onChange={onGraph}
          onEditContent={(poolId) => {
            setFocusPool(poolId);
            setTab("content");
          }}
        />
      ) : null}
      {tab === "content" ? (
        <PoolsEditor
          pools={draft.pools}
          fields={fields}
          catalog={connection?.catalog}
          productName={waitlist ? (launch?.name ?? "your launch") : (connection?.name ?? "your product")}
          waitlist={waitlist}
          brand={detail.sender.fromName ?? draft.settings.sender.fromName ?? "Your brand"}
          postalAddress={detail.postalAddress}
          readOnly={readOnly}
          focusPoolId={focusPool}
          onFocusPool={setFocusPool}
          onChange={(pools) => edit({ pools })}
        />
      ) : null}
      {tab === "settings" ? (
        <SettingsPanel
          settings={draft.settings}
          catalog={connection?.catalog}
          sender={detail.sender}
          readOnly={readOnly}
          waitlist={waitlist && launch ? { launchId: launch.id, launchName: launch.name } : null}
          consentAtSend={detail.features.consentAtSend}
          onChange={(settings) => edit({ settings })}
        />
      ) : null}
      {tab === "delivery" ? (
        <DeliveryPanel
          detail={detail}
          canEdit={canEdit}
          onSaved={(j) => setDetail((d) => (d ? { ...d, journey: { ...j, draft: d.journey.draft } } : d))}
        />
      ) : null}
      {tab === "people" ? (
        <EnrolmentsPanel
          journey={journey}
          draft={draft}
          sandboxUserIds={(connection?.sandboxUsers ?? []).map((u) => u.userId)}
          canEdit={canEdit}
        />
      ) : null}
      {tab === "preview" && !waitlist ? (
        <TimelinePreview
          journeyId={journey.id}
          catalog={connection?.catalog}
          defaultTimezone={connection?.defaults.timezone ?? draft.settings.sendPolicy.fallbackTimezone}
          dirty={dirty}
        />
      ) : null}
      {tab === "results" ? <AnalyticsPanel journeyId={journey.id} /> : null}
        </div>
        {chatOpen && connection ? (
          <LifecycleChatPanel
            connectionId={connection.id}
            journeyId={journey.id}
            onClose={() => setChatOpen(false)}
            onDraftSaved={onChatSaved}
          />
        ) : null}
      </div>
    </div>
  );
}

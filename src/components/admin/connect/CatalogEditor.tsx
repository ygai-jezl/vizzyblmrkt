"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { describeChanges, rebaseCatalog } from "@/lib/connect/catalogChanges";
import { api, errorText, type ConnectionCatalog, type ConnectionDiagnostics, type PublicConnection } from "./api";
import { CatalogHistory } from "./CatalogHistory";
import { Banner, Button, Section, inputClass } from "./ui";

/** Catalogs saved before facts (or entity kinds) existed have none. */
const withLists = (c: ConnectionCatalog): ConnectionCatalog => ({ ...c, facts: c.facts ?? [], entityKinds: c.entityKinds ?? [] });

type Version = { catalog: ConnectionCatalog; rev: number };
type SaveReply = { connection?: PublicConnection; error?: string; catalog?: ConnectionCatalog; catalogRev?: number };

/** Up to this many edits are listed when the catalog changed elsewhere. */
const EDITS_SHOWN = 12;

/**
 * The connection's catalog: what the product sends and what it means. Journeys
 * branch on these fields and the AI uses the labels + glossary for grounding.
 * "Add observed" pulls in event names and trait keys that have actually arrived.
 *
 * A save names the version it was edited from and is refused when the catalog
 * has changed since (another tab, Learn from repo, a colleague): the edits are
 * listed and can be carried over onto the newer version, so neither is lost.
 */
export function CatalogEditor({
  connection,
  diagnostics,
  canEdit,
  onSaved,
  entities = false,
  history = false,
  onDirtyChange,
}: {
  connection: PublicConnection;
  diagnostics: ConnectionDiagnostics | null;
  canEdit: boolean;
  onSaved: () => void;
  /** API v2 entities are on: name the things people have several of, and which steps and facts are per one. */
  entities?: boolean;
  /** Catalog history is on (CATALOG_HISTORY_ENABLED): list saved versions, with Restore. */
  history?: boolean;
  /** Whether there are unsaved edits — the page asks before leaving the tab. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  /** The saved version the edits started from. */
  const [base, setBase] = useState<Version>(() => ({ catalog: withLists(connection.catalog), rev: connection.catalogRev ?? 0 }));
  const [cat, setCat] = useState<ConnectionCatalog>(() => withLists(connection.catalog));
  /** A version saved elsewhere since `base`, while there are unsaved edits. */
  const [newer, setNewer] = useState<Version | null>(null);
  /** Clashes found carrying edits over onto a newer version. */
  const [notes, setNotes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err" | "info"; text: string } | null>(null);

  const edits = useMemo(() => describeChanges(base.catalog, cat), [base, cat]);
  const dirty = edits.length > 0;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  // Closing or reloading the page with unsaved edits asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // The page fetched a newer catalog: it replaces an untouched copy, and is offered when there are edits.
  const latestRev = connection.catalogRev ?? 0;
  useEffect(() => {
    if (latestRev <= base.rev) return;
    const latest = { catalog: withLists(connection.catalog), rev: latestRev };
    if (dirty) {
      setNewer(latest);
      return;
    }
    setBase(latest);
    setCat(latest.catalog);
    setNewer(null);
    setMsg({ tone: "info", text: "Showing the latest version: the catalog was changed elsewhere since this page opened." });
  }, [latestRev, connection.catalog, base.rev, dirty]);

  /** Show a saved version as the one being edited. */
  function adopt(v: Version) {
    setBase(v);
    setCat(v.catalog);
    setNewer(null);
    setNotes([]);
  }

  const knownEvents = new Set(cat.events.map((e) => e.name));
  const knownTraits = new Set(cat.traits.map((t) => t.key));
  const observedEvents = Object.keys(diagnostics?.observedEvents ?? {}).filter((n) => !knownEvents.has(n));
  const observedTraits = Object.entries(diagnostics?.observedTraits ?? {}).filter(([k]) => !knownTraits.has(k));

  function update<K extends keyof ConnectionCatalog>(key: K, value: ConnectionCatalog[K]) {
    setCat((c) => ({ ...c, [key]: value }));
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    const r = await api<SaveReply>(`/api/admin/connections/${connection.id}`, {
      method: "PATCH",
      body: JSON.stringify({ catalog: cat, catalogRev: base.rev }),
    });
    setBusy(false);
    if (r.data.error === "catalog_changed" && r.data.catalog) {
      return setNewer({ catalog: withLists(r.data.catalog), rev: r.data.catalogRev ?? 0 });
    }
    if (!r.ok || !r.data.connection) return setMsg({ tone: "err", text: errorText(r.data) });
    adopt({ catalog: withLists(r.data.connection.catalog), rev: r.data.connection.catalogRev ?? 0 });
    setMsg({ tone: "ok", text: "Catalog saved." });
    onSaved();
  }

  /** Put the unsaved edits on top of the newer version, to check and save. */
  function carryOver() {
    if (!newer) return;
    const r = rebaseCatalog(base.catalog, cat, newer.catalog);
    setBase(newer);
    setCat(withLists(r.catalog));
    setNewer(null);
    setNotes(r.notes);
    setMsg({ tone: "info", text: "Your edits are now on top of the latest version. Check them, then save." });
  }

  async function restore(rev: number) {
    setMsg(null);
    const r = await api<SaveReply>(`/api/admin/connections/${connection.id}/catalog-history/${rev}/restore`, {
      method: "POST",
      body: JSON.stringify({ catalogRev: base.rev }),
    });
    if (r.data.error === "catalog_changed" && r.data.catalog) {
      adopt({ catalog: withLists(r.data.catalog), rev: r.data.catalogRev ?? 0 });
      setMsg({ tone: "err", text: "The catalog changed since this page loaded, so nothing was restored. Here's the latest — restore again if you still want to." });
      return;
    }
    if (!r.ok || !r.data.connection) return setMsg({ tone: "err", text: errorText(r.data) });
    const saved = { catalog: withLists(r.data.connection.catalog), rev: r.data.connection.catalogRev ?? 0 };
    adopt(saved);
    setMsg({ tone: "ok", text: `Restored version ${rev}, saved as version ${saved.rev}.` });
    onSaved();
  }

  const row = "grid gap-2 sm:grid-cols-[1fr_1fr_2fr_auto]";
  const disabled = !canEdit;
  const showKinds = entities || cat.entityKinds.length > 0;
  const perVisible = showKinds && cat.entityKinds.length > 0;
  /** "Per person" or per one of the kinds, for a step or fact. */
  const perSelect = (value: string | null | undefined, onPick: (kind: string | null) => void, label: string) =>
    perVisible ? (
      <select className={inputClass} disabled={disabled} aria-label={label} value={value ?? ""} onChange={(e) => onPick(e.target.value || null)}>
        <option value="">Per person</option>
        {cat.entityKinds.map((k) => (
          <option key={k.kind} value={k.kind}>
            Per {k.label}
          </option>
        ))}
      </select>
    ) : null;

  return (
    <div className="space-y-4">
      {newer ? (
        <div role="alert" className="space-y-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <p className="font-medium">
            This catalog was changed elsewhere since you opened it — in another tab, by Learn from repo, or by someone else. Your edits
            aren&apos;t saved yet:
          </p>
          <ul className="list-disc pl-5">
            {edits.slice(0, EDITS_SHOWN).map((e, i) => (
              <li key={i}>{e}</li>
            ))}
            {edits.length > EDITS_SHOWN ? <li>…and {edits.length - EDITS_SHOWN} more</li> : null}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button tone="primary" onClick={carryOver}>
              Keep my edits on the latest version
            </Button>
            <Button onClick={() => adopt(newer)}>Discard my edits</Button>
          </div>
        </div>
      ) : null}
      {msg ? <Banner tone={msg.tone}>{msg.text}</Banner> : null}
      {notes.length > 0 ? (
        <ul className="list-disc pl-5 text-sm text-neutral-600 dark:text-neutral-400">
          {notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      ) : null}

      {showKinds ? (
        <Section
          title="Things people have several of"
          description="Workspaces, brands, projects — whatever your product lets one person have several of. For each kind: the id your server sends as its kind, what emails call one and several, and what it sits inside (a brand inside a workspace). Then mark the steps and facts below that are per one of them. Your server sends them as entities, and each journey says which of them its emails are about."
        >
          {cat.entityKinds.map((k, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_1fr_auto]">
              <input className={`${inputClass} font-mono`} disabled={disabled} value={k.kind}
                placeholder="Kind id your server sends — e.g. brand" aria-label="Kind id"
                title="The kind exactly as your server sends it in entities: lower case, letters, digits and _"
                onChange={(e) => update("entityKinds", cat.entityKinds.map((x) => (x === k ? { ...x, kind: e.target.value.trim().toLowerCase() } : x)))} />
              <input className={inputClass} disabled={disabled} value={k.label}
                placeholder="What emails call one — e.g. brand" aria-label="What emails call one"
                title="How emails and journeys name one of them, e.g. “your brand Acme”"
                onChange={(e) => update("entityKinds", cat.entityKinds.map((x) => (x === k ? { ...x, label: e.target.value } : x)))} />
              <input className={inputClass} disabled={disabled} value={k.plural}
                placeholder="What emails call several — e.g. brands" aria-label="What emails call several"
                title="How emails and journeys name several of them, e.g. “all 3 of your brands”"
                onChange={(e) => update("entityKinds", cat.entityKinds.map((x) => (x === k ? { ...x, plural: e.target.value } : x)))} />
              <select className={inputClass} disabled={disabled} aria-label="Sits inside" value={k.parent ?? ""}
                title="Whether one sits inside another kind, e.g. a brand inside a workspace"
                onChange={(e) => update("entityKinds", cat.entityKinds.map((x) => (x === k ? { ...x, parent: e.target.value || null } : x)))}>
                <option value="">Not inside another kind</option>
                {cat.entityKinds.filter((x) => x !== k).map((x) => (
                  <option key={x.kind} value={x.kind}>Inside a {x.label || x.kind}</option>
                ))}
              </select>
              <Button tone="danger" disabled={disabled} aria-label="Remove kind" onClick={() => update("entityKinds", cat.entityKinds.filter((x) => x !== k))}>
                <Trash2 size={14} />
              </Button>
            </div>
          ))}
          <Button disabled={disabled || cat.entityKinds.length >= 10}
            onClick={() => update("entityKinds", [...cat.entityKinds, { kind: "", label: "", plural: "", parent: null, multiple: true, description: "" }])}>
            <Plus size={14} /> Add kind
          </Button>
        </Section>
      ) : null}

      <Section title="Onboarding steps" description="In order. Journeys nudge users towards the next one; step ids match onboarding.step_completed events.">
        {[...cat.onboardingSteps]
          .sort((a, b) => a.order - b.order)
          .map((s, i) => (
            <div key={i} className={row}>
              <input className={inputClass} disabled={disabled} value={s.id} placeholder="create_brand"
                onChange={(e) => update("onboardingSteps", cat.onboardingSteps.map((x) => (x === s ? { ...x, id: e.target.value } : x)))} />
              <input className={inputClass} disabled={disabled} value={s.label} placeholder="Add your brand"
                onChange={(e) => update("onboardingSteps", cat.onboardingSteps.map((x) => (x === s ? { ...x, label: e.target.value } : x)))} />
              <input className={inputClass} disabled={disabled} value={s.url ?? ""} placeholder="https://app.example.com/brand/new"
                onChange={(e) => update("onboardingSteps", cat.onboardingSteps.map((x) => (x === s ? { ...x, url: e.target.value || null } : x)))} />
              <Button tone="danger" disabled={disabled} aria-label="Remove step"
                onClick={() => update("onboardingSteps", cat.onboardingSteps.filter((x) => x !== s).map((x, j) => ({ ...x, order: j })))}>
                <Trash2 size={14} />
              </Button>
              <input className={`${inputClass} ${perVisible ? "sm:col-span-3" : "sm:col-span-4"}`} disabled={disabled} value={s.completion ?? ""}
                placeholder="How your product decides it's done — e.g. an audit has finished"
                onChange={(e) => update("onboardingSteps", cat.onboardingSteps.map((x) => (x === s ? { ...x, completion: e.target.value.slice(0, 500) } : x)))} />
              {perSelect(s.kind, (kind) => update("onboardingSteps", cat.onboardingSteps.map((x) => (x === s ? { ...x, kind } : x))), "Done per")}
            </div>
          ))}
        <Button disabled={disabled || cat.onboardingSteps.length >= 20}
          onClick={() => update("onboardingSteps", [...cat.onboardingSteps, { id: "", label: "", url: null, order: cat.onboardingSteps.length }])}>
          <Plus size={14} /> Add step
        </Button>
      </Section>

      <Section title="Events" description="Event names your product sends, with what they mean.">
        {cat.events.map((ev, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_2fr_auto]">
            <input className={`${inputClass} font-mono`} disabled={disabled} value={ev.name}
              onChange={(e) => update("events", cat.events.map((x) => (x === ev ? { ...x, name: e.target.value } : x)))} />
            <input className={inputClass} disabled={disabled} value={ev.label} placeholder="Label"
              onChange={(e) => update("events", cat.events.map((x) => (x === ev ? { ...x, label: e.target.value } : x)))} />
            <input className={inputClass} disabled={disabled} value={ev.description} placeholder="What it means"
              onChange={(e) => update("events", cat.events.map((x) => (x === ev ? { ...x, description: e.target.value } : x)))} />
            <Button tone="danger" disabled={disabled} aria-label="Remove event" onClick={() => update("events", cat.events.filter((x) => x !== ev))}>
              <Trash2 size={14} />
            </Button>
          </div>
        ))}
        {observedEvents.length > 0 && canEdit ? (
          <div className="flex flex-wrap items-center gap-1 text-xs text-neutral-500">
            Observed but not in the catalog:
            {observedEvents.map((n) => (
              <Button key={n} className="font-mono text-xs" onClick={() => update("events", [...cat.events, { name: n, label: "", description: "" }])}>
                <Plus size={12} /> {n}
              </Button>
            ))}
          </div>
        ) : null}
      </Section>

      <Section title="Traits" description="User attributes your product sends in identify (e.g. plan). Journeys can branch on them.">
        {cat.traits.map((t, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[1fr_8rem_2fr_auto]">
            <input className={`${inputClass} font-mono`} disabled={disabled} value={t.key}
              onChange={(e) => update("traits", cat.traits.map((x) => (x === t ? { ...x, key: e.target.value } : x)))} />
            <select className={inputClass} disabled={disabled} value={t.type}
              onChange={(e) => update("traits", cat.traits.map((x) => (x === t ? { ...x, type: e.target.value as typeof t.type } : x)))}>
              {["string", "number", "boolean", "timestamp"].map((ty) => <option key={ty} value={ty}>{ty}</option>)}
            </select>
            <input className={inputClass} disabled={disabled} value={t.label} placeholder="Label"
              onChange={(e) => update("traits", cat.traits.map((x) => (x === t ? { ...x, label: e.target.value } : x)))} />
            <Button tone="danger" disabled={disabled} aria-label="Remove trait" onClick={() => update("traits", cat.traits.filter((x) => x !== t))}>
              <Trash2 size={14} />
            </Button>
          </div>
        ))}
        {observedTraits.length > 0 && canEdit ? (
          <div className="flex flex-wrap items-center gap-1 text-xs text-neutral-500">
            Observed but not in the catalog:
            {observedTraits.map(([k, v]) => (
              <Button key={k} className="font-mono text-xs"
                onClick={() => update("traits", [...cat.traits, { key: k, type: v.type === "number" || v.type === "boolean" ? v.type : "string", label: "", description: "" }])}>
                <Plus size={12} /> {k}
              </Button>
            ))}
          </div>
        ) : null}
      </Section>

      <Section
        title="Facts"
        description="Numbers (or values) your context endpoint can return about each user — the raw material for insights, and fields journeys can branch on. Ids must match the facts your endpoint returns."
      >
        {cat.facts.map((f, i) => (
          <div key={i} className={`grid gap-2 ${perVisible ? "sm:grid-cols-[1fr_1fr_7rem_5rem_2fr_2fr_8rem_auto]" : "sm:grid-cols-[1fr_1fr_7rem_5rem_2fr_2fr_auto]"}`}>
            <input className={`${inputClass} font-mono`} disabled={disabled} value={f.id} placeholder="share_of_voice"
              onChange={(e) => update("facts", cat.facts.map((x) => (x === f ? { ...x, id: e.target.value } : x)))} />
            <input className={inputClass} disabled={disabled} value={f.label} placeholder="Share of voice"
              onChange={(e) => update("facts", cat.facts.map((x) => (x === f ? { ...x, label: e.target.value } : x)))} />
            <select className={inputClass} disabled={disabled} value={f.type}
              onChange={(e) => update("facts", cat.facts.map((x) => (x === f ? { ...x, type: e.target.value as typeof f.type } : x)))}>
              {["number", "string", "boolean"].map((ty) => <option key={ty} value={ty}>{ty}</option>)}
            </select>
            <input className={inputClass} disabled={disabled} value={f.unit ?? ""} placeholder="%"
              onChange={(e) => update("facts", cat.facts.map((x) => (x === f ? { ...x, unit: e.target.value || null } : x)))} />
            <input className={inputClass} disabled={disabled} value={f.source} placeholder="Where it comes from"
              onChange={(e) => update("facts", cat.facts.map((x) => (x === f ? { ...x, source: e.target.value } : x)))} />
            <input className={inputClass} disabled={disabled} value={f.appliesWhen ?? ""} placeholder="Only for… (blank: everyone)" aria-label="Only for"
              onChange={(e) => update("facts", cat.facts.map((x) => (x === f ? { ...x, appliesWhen: e.target.value || undefined } : x)))} />
            {perSelect(f.kind, (kind) => update("facts", cat.facts.map((x) => (x === f ? { ...x, kind } : x))), "Value per")}
            <Button tone="danger" disabled={disabled} aria-label="Remove fact" onClick={() => update("facts", cat.facts.filter((x) => x !== f))}>
              <Trash2 size={14} />
            </Button>
          </div>
        ))}
        <Button disabled={disabled || cat.facts.length >= 50}
          onClick={() => update("facts", [...cat.facts, { id: "", label: "", type: "number", unit: null, description: "", source: "" }])}>
          <Plus size={14} /> Add fact
        </Button>
      </Section>

      <Section title="Glossary" description="Terms the AI may use when writing about your product.">
        {cat.glossary.map((g, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[1fr_3fr_auto]">
            <input className={inputClass} disabled={disabled} value={g.term}
              onChange={(e) => update("glossary", cat.glossary.map((x) => (x === g ? { ...x, term: e.target.value } : x)))} />
            <input className={inputClass} disabled={disabled} value={g.definition}
              onChange={(e) => update("glossary", cat.glossary.map((x) => (x === g ? { ...x, definition: e.target.value } : x)))} />
            <Button tone="danger" disabled={disabled} aria-label="Remove term" onClick={() => update("glossary", cat.glossary.filter((x) => x !== g))}>
              <Trash2 size={14} />
            </Button>
          </div>
        ))}
        <Button disabled={disabled} onClick={() => update("glossary", [...cat.glossary, { term: "", definition: "" }])}>
          <Plus size={14} /> Add term
        </Button>
      </Section>

      {canEdit ? (
        <div className="flex items-center justify-end gap-3">
          {dirty ? (
            <span className="text-xs text-neutral-500">
              {edits.length} unsaved change{edits.length === 1 ? "" : "s"}
            </span>
          ) : null}
          <Button tone="primary" disabled={busy || !dirty || newer !== null} onClick={save}>
            {busy ? "Saving…" : "Save catalog"}
          </Button>
        </div>
      ) : null}

      {history ? <CatalogHistory connectionId={connection.id} currentRev={base.rev} canEdit={canEdit} dirty={dirty} onRestore={restore} /> : null}
    </div>
  );
}

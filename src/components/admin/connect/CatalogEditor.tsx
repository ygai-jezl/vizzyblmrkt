"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { api, errorText, type ConnectionCatalog, type ConnectionDiagnostics, type PublicConnection } from "./api";
import { Banner, Button, Section, inputClass } from "./ui";

/**
 * The connection's catalog: what the product sends and what it means. Journeys
 * branch on these fields and the AI uses the labels + glossary for grounding.
 * "Add observed" pulls in event names and trait keys that have actually arrived.
 */
export function CatalogEditor({
  connection,
  diagnostics,
  canEdit,
  onSaved,
}: {
  connection: PublicConnection;
  diagnostics: ConnectionDiagnostics | null;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const [cat, setCat] = useState<ConnectionCatalog>(connection.catalog);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

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
    const r = await api(`/api/admin/connections/${connection.id}`, {
      method: "PATCH",
      body: JSON.stringify({ catalog: cat }),
    });
    setBusy(false);
    if (!r.ok) return setMsg({ tone: "err", text: errorText(r.data) });
    setMsg({ tone: "ok", text: "Catalog saved." });
    onSaved();
  }

  const row = "grid gap-2 sm:grid-cols-[1fr_1fr_2fr_auto]";
  const disabled = !canEdit;

  return (
    <div className="space-y-4">
      {msg ? <Banner tone={msg.tone}>{msg.text}</Banner> : null}

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
        <div className="flex justify-end">
          <Button tone="primary" disabled={busy} onClick={save}>
            {busy ? "Saving…" : "Save catalog"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

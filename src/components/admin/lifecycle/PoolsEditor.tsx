"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Eye, Plus, Trash2 } from "lucide-react";
import type { ContentPool, PoolItem } from "@/lib/types/lifecycle";
import type { ConnectionCatalog } from "@/lib/types/productConnection";
import { renderLifecycleEmail, type RenderValues } from "@/lib/lifecycle/render";
import { ConditionList } from "./ConditionList";
import type { FieldOption } from "./model";
import { Badge, Button, Field, inputClass } from "../connect/ui";

/**
 * Content pools: the emails each Email step can send. A step sends the FIRST
 * email in its pool that the person hasn't had and is eligible for — so order
 * matters. Previews render with sample values through the same renderer the
 * runner uses.
 */

const SLUG = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base) && SLUG.test(base)) return base;
  for (let i = 2; i < 100; i += 1) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
  return `${base}_${Math.random().toString(36).slice(2, 6)}`;
}

const TOKENS = [
  ["{{user.first_name|there}}", "First name, with a fallback"],
  ["{{product.name}}", "Your product's name"],
  ["{{next_step.label}} / {{next_step.url}}", "The person's next onboarding step"],
  ["{{onboarding.steps_remaining}}", "Steps still to do"],
  ["{{trait.plan}}", "Any trait the product sends"],
  ["{{fact.share_of_voice}}", "A fact from the product's context"],
  ["{{block.checklist}}", "✓/☐ onboarding checklist"],
  ["{{block.next_step}}", "Button (or link, in letters) to the next step"],
  ["{{block.insight}}", "The product's insight for this person"],
] as const;

function sampleValues(catalog: ConnectionCatalog | undefined, productName: string, brand: string, postalAddress: string | null): RenderValues {
  const steps = [...(catalog?.onboardingSteps ?? [])].sort((a, b) => a.order - b.order);
  return {
    user: { id: "preview", first_name: "Alex", email: "alex@example.com" },
    product: { name: productName },
    traits: {},
    facts: [],
    nextStep: steps[1] ? { label: steps[1].label, url: steps[1].url ?? null } : null,
    checklist: steps.map((s, i) => ({ label: s.label, done: i === 0, url: s.url ?? null })),
    insight: { sentence: "(The product's insight for this person appears here.)", aiLine: null },
    footer: { brand, unsubscribeUrl: "#", managePreferencesUrl: "#", privacyUrl: "#", postalAddress },
  };
}

export function PoolsEditor({
  pools,
  fields,
  catalog,
  productName,
  brand,
  postalAddress,
  readOnly,
  focusPoolId,
  onFocusPool,
  onChange,
}: {
  pools: ContentPool[];
  fields: FieldOption[];
  catalog: ConnectionCatalog | undefined;
  productName: string;
  brand: string;
  postalAddress: string | null;
  readOnly: boolean;
  focusPoolId: string | null;
  onFocusPool: (id: string | null) => void;
  onChange: (pools: ContentPool[]) => void;
}) {
  const current = pools.find((p) => p.id === focusPoolId) ?? pools[0] ?? null;
  const values = useMemo(() => sampleValues(catalog, productName, brand, postalAddress), [catalog, productName, brand, postalAddress]);

  const setPool = (id: string, patch: Partial<ContentPool>) => onChange(pools.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const setItems = (pool: ContentPool, items: PoolItem[]) => setPool(pool.id, { items });

  const addPool = () => {
    const id = uniqueId("pool", new Set(pools.map((p) => p.id)));
    onChange([...pools, { id, label: "New content", items: [blankItem("email_1")] }]);
    onFocusPool(id);
  };

  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      <nav className="w-full shrink-0 space-y-1 lg:w-56">
        {pools.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onFocusPool(p.id)}
            className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-sm ${
              current?.id === p.id ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900" : "hover:bg-neutral-100 dark:hover:bg-neutral-900"
            }`}
          >
            <span className="truncate">{p.label}</span>
            <span className="text-xs opacity-70">{p.items.length}</span>
          </button>
        ))}
        {!readOnly ? (
          <Button onClick={addPool} className="mt-2 w-full justify-center">
            <Plus size={14} /> Content pool
          </Button>
        ) : null}
        <details className="mt-4 rounded-md border border-neutral-200 p-2 text-xs dark:border-neutral-800">
          <summary className="cursor-pointer font-medium">Personalisation tokens</summary>
          <ul className="mt-2 space-y-1.5">
            {TOKENS.map(([t, d]) => (
              <li key={t}>
                <code className="break-all font-mono">{t}</code>
                <div className="text-neutral-500">{d}</div>
              </li>
            ))}
          </ul>
        </details>
      </nav>

      {current ? (
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Pool name">
              <input className={`${inputClass} w-64`} value={current.label} disabled={readOnly} onChange={(e) => setPool(current.id, { label: e.target.value.slice(0, 120) })} />
            </Field>
            <span className="pb-2 font-mono text-xs text-neutral-500">{current.id}</span>
            {!readOnly ? (
              <Button
                tone="danger"
                className="ml-auto"
                onClick={() => {
                  if (!window.confirm(`Delete "${current.label}"? Email steps using it will need new content.`)) return;
                  onChange(pools.filter((p) => p.id !== current.id));
                  onFocusPool(null);
                }}
              >
                <Trash2 size={14} /> Delete pool
              </Button>
            ) : null}
          </div>
          <p className="text-xs text-neutral-500">
            Sent in this order: each time a step uses this pool, the person gets the first email here they haven&rsquo;t had
            and are eligible for.
          </p>
          <ol className="space-y-3">
            {current.items.map((item, i) => (
              <li key={item.id}>
                <ItemEditor
                  item={item}
                  index={i}
                  count={current.items.length}
                  fields={fields}
                  values={values}
                  readOnly={readOnly}
                  onChange={(next) => setItems(current, current.items.map((x, j) => (j === i ? next : x)))}
                  onMove={(dir) => {
                    const items = [...current.items];
                    const [moved] = items.splice(i, 1);
                    items.splice(i + dir, 0, moved!);
                    setItems(current, items);
                  }}
                  onRemove={() => setItems(current, current.items.filter((_, j) => j !== i))}
                />
              </li>
            ))}
          </ol>
          {!readOnly && current.items.length < 10 ? (
            <Button
              onClick={() => {
                const id = uniqueId(`email_${current.items.length + 1}`, new Set(current.items.map((x) => x.id)));
                setItems(current, [...current.items, blankItem(id)]);
              }}
            >
              <Plus size={14} /> Email
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-neutral-500">No content yet — add a content pool.</p>
      )}
    </div>
  );
}

function blankItem(id: string): PoolItem {
  return {
    id,
    label: "New email",
    subject: "",
    previewText: null,
    body: "Hi {{user.first_name|there}},\n\n",
    layout: null,
    format: "letter",
    messageClass: "marketing",
    personalization: "none",
  };
}

function ItemEditor({
  item,
  index,
  count,
  fields,
  values,
  readOnly,
  onChange,
  onMove,
  onRemove,
}: {
  item: PoolItem;
  index: number;
  count: number;
  fields: FieldOption[];
  values: RenderValues;
  readOnly: boolean;
  onChange: (next: PoolItem) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(index === 0);
  const [preview, setPreview] = useState(false);
  const set = (patch: Partial<PoolItem>) => onChange({ ...item, ...patch });
  const rendered = useMemo(() => (preview ? renderLifecycleEmail({ item, values }) : null), [preview, item, values]);
  const eligibility = item.eligibility ?? { match: "all" as const, conditions: [] };

  return (
    <div className="rounded-lg border border-neutral-200 dark:border-neutral-800">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpen(!open)}>
          <span className="mr-2 text-xs text-neutral-400">{index + 1}.</span>
          <span className="text-sm font-medium">{item.label}</span>
          <span className="ml-2 truncate text-xs text-neutral-500">{item.subject || "No subject"}</span>
        </button>
        <span className="flex gap-1">
          {item.messageClass === "service" ? <Badge tone="green">service</Badge> : null}
          {item.format === "letter" ? <Badge>letter</Badge> : null}
          {eligibility.conditions.length ? <Badge tone="amber">conditional</Badge> : null}
        </span>
        {!readOnly ? (
          <span className="flex gap-0.5">
            <button type="button" className="rounded p-1 text-neutral-400 hover:text-neutral-700 disabled:opacity-30" disabled={index === 0} onClick={() => onMove(-1)} aria-label="Move up">
              <ArrowUp size={14} />
            </button>
            <button type="button" className="rounded p-1 text-neutral-400 hover:text-neutral-700 disabled:opacity-30" disabled={index === count - 1} onClick={() => onMove(1)} aria-label="Move down">
              <ArrowDown size={14} />
            </button>
            <button type="button" className="rounded p-1 text-neutral-400 hover:text-red-600 disabled:opacity-30" disabled={count === 1} onClick={onRemove} aria-label="Delete email">
              <Trash2 size={14} />
            </button>
          </span>
        ) : null}
      </div>
      {open ? (
        <div className="space-y-3 border-t border-neutral-200 p-3 dark:border-neutral-800">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name (internal)">
              <input className={inputClass} value={item.label} disabled={readOnly} onChange={(e) => set({ label: e.target.value.slice(0, 120) })} />
            </Field>
            <Field label="Subject">
              <input className={inputClass} value={item.subject} disabled={readOnly} onChange={(e) => set({ subject: e.target.value.slice(0, 200) })} />
            </Field>
            <Field label="Preview text" hint="Shown after the subject in most inboxes.">
              <input className={inputClass} value={item.previewText ?? ""} disabled={readOnly} onChange={(e) => set({ previewText: e.target.value.slice(0, 200) || null })} />
            </Field>
            <div className="grid grid-cols-3 gap-2">
              <Field label="Style">
                <select className={inputClass} value={item.format} disabled={readOnly} onChange={(e) => set({ format: e.target.value as PoolItem["format"] })}>
                  <option value="branded">Branded</option>
                  <option value="letter">Letter</option>
                </select>
              </Field>
              <Field label="Type">
                <select className={inputClass} value={item.messageClass} disabled={readOnly} onChange={(e) => set({ messageClass: e.target.value as PoolItem["messageClass"] })}>
                  <option value="marketing">Marketing</option>
                  <option value="service">Service</option>
                </select>
              </Field>
              <Field label="AI line">
                <select className={inputClass} value={item.personalization} disabled={readOnly} onChange={(e) => set({ personalization: e.target.value as PoolItem["personalization"] })}>
                  <option value="none">Off</option>
                  <option value="ai_line">Reviewed</option>
                </select>
              </Field>
            </div>
          </div>
          {item.layout ? (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              This email was designed in the layout editor; the body below is generated from it and editing it here
              replaces the design.
            </p>
          ) : null}
          <Field label="Body" hint="HTML or plain text. Blank lines make paragraphs. Tokens are filled in per person at send time.">
            <textarea
              className={`${inputClass} min-h-40 font-mono text-xs`}
              value={item.body}
              disabled={readOnly}
              onChange={(e) => set({ body: e.target.value.slice(0, 20000), layout: null })}
            />
          </Field>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">Only send when</span>
              {eligibility.conditions.length > 1 ? (
                <select className={`${inputClass} w-auto`} value={eligibility.match} disabled={readOnly} onChange={(e) => set({ eligibility: { ...eligibility, match: e.target.value as "all" | "any" } })}>
                  <option value="all">all of these hold</option>
                  <option value="any">any of these holds</option>
                </select>
              ) : null}
              {eligibility.conditions.length === 0 ? <span className="text-xs text-neutral-500">(always)</span> : null}
            </div>
            <ConditionList
              conditions={eligibility.conditions}
              fields={fields}
              disabled={readOnly}
              onChange={(conditions) => set({ eligibility: conditions.length ? { ...eligibility, conditions } : undefined })}
            />
          </div>
          <div className="space-y-2">
            <Button onClick={() => setPreview(!preview)}>
              <Eye size={14} /> {preview ? "Hide preview" : "Preview with sample data"}
            </Button>
            {rendered ? (
              <div className="space-y-1">
                <p className="text-sm">
                  <span className="text-neutral-500">Subject:</span> {rendered.subject || <i>empty</i>}
                </p>
                {rendered.missing.length ? (
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    No sample value for: {rendered.missing.join(", ")} — for a real person without these, this email is skipped
                    and the next eligible one sends instead. Add a fallback like {"{{token|fallback}}"}.
                  </p>
                ) : null}
                <iframe title={`Preview of ${item.label}`} sandbox="" srcDoc={rendered.html} className="h-[480px] w-full rounded-md border border-neutral-200 bg-white dark:border-neutral-800" />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

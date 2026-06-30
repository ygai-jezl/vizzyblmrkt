"use client";

import { useState } from "react";
import { CHANNELS, channelLabel } from "@/lib/content/channels";
import { contentMatrixLabel } from "@/lib/content/contentMatrix";
import { IngestBar } from "@/components/admin/workspace/IngestBar";
import type { IngestionTicket } from "@/lib/types/ingestionTicket";
import type { ContentObjective, ContentPlan } from "@/lib/types/contentPlan";

/**
 * Create intake wizard — 4 short steps (Strategy / Scope / Knowledge / Topology) +
 * a top-level Name. Submit creates the ContentPlan then runs the Architect; the
 * parent navigates to the canvas. The Knowledge step reuses IngestBar so an operator
 * can add a grounding source mid-flow (it becomes selectable once vectorized).
 */
const OBJECTIVES: { id: ContentObjective; label: string; hint: string }[] = [
  { id: "newsletter_signups", label: "Newsletter signups", hint: "Grow the list" },
  { id: "product_launch", label: "Product launch", hint: "Drive a launch moment" },
  { id: "brand_visibility", label: "Brand visibility", hint: "Top-of-funnel reach" },
];

// Spokes are social channels (the hub is newsletter/blog; "standalone" isn't a destination).
const SPOKE_OPTIONS = CHANNELS.filter((c) => !["newsletter", "blog", "standalone"].includes(c.id));

const STEPS = ["Strategy", "Scope", "Knowledge", "Topology"] as const;

export function CreateWizard({
  workspaceId,
  topics,
  initialSources,
  onCreated,
  onCancel,
}: {
  workspaceId: string;
  topics: string[];
  initialSources: IngestionTicket[];
  onCreated: (plan: ContentPlan) => void;
  onCancel: () => void;
}) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [objective, setObjective] = useState<ContentObjective>("newsletter_signups");
  const [hubUrl, setHubUrl] = useState("");
  const [subscriberCount, setSubscriberCount] = useState("");
  const [selectedTopics, setSelectedTopics] = useState<string[]>([]);
  const [spark, setSpark] = useState("");
  const [groundingScope, setGroundingScope] = useState<"global" | "scoped">("global");
  const [proof, setProof] = useState("");
  const [hubChannel, setHubChannel] = useState<"newsletter" | "blog">("newsletter");
  const [spokeChannels, setSpokeChannels] = useState<string[]>(["linkedin", "x"]);
  const [sources, setSources] = useState<IngestionTicket[]>(initialSources);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const doneSources = sources.filter((s) => s.status === "done");

  async function refreshSources() {
    try {
      const res = await fetch(
        `/api/admin/knowledge/sources?ownerKind=workspace&ownerId=${encodeURIComponent(workspaceId)}`,
      );
      const data = (await res.json().catch(() => ({}))) as { tickets?: IngestionTicket[] };
      if (data.tickets) setSources(data.tickets);
    } catch {
      /* non-fatal */
    }
  }

  function toggle(list: string[], value: string): string[] {
    return list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
  }

  function next() {
    setErr(null);
    if (step === 0 && !name.trim()) {
      setErr("Give this workflow a name.");
      return;
    }
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }

  async function submit() {
    if (!name.trim()) {
      setStep(0);
      setErr("Give this workflow a name.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const subCount = subscriberCount.trim() ? Math.max(0, parseInt(subscriberCount, 10) || 0) : null;
      const createRes = await fetch(
        `/api/admin/workspace/${workspaceId}/content-plans`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name.trim(),
            strategy: {
              objective,
              hubUrl: hubUrl.trim() || null,
              subscriberCount: subCount,
            },
            scope: { topics: selectedTopics, spark: spark.trim() },
            knowledge: {
              groundingScope: selectedTopics.length ? groundingScope : "global",
              proofAssets: proof.trim() ? [proof.trim()] : [],
            },
            topology: { hubChannel, spokeChannels },
          }),
        },
      );
      const created = (await createRes.json().catch(() => ({}))) as {
        plan?: ContentPlan;
        error?: string;
      };
      if (!createRes.ok || !created.plan) {
        setErr(created.error === "invalid_input" ? "Check the form fields." : "Couldn't create the workflow.");
        return;
      }
      // Architect builds the canvas skeleton.
      const genRes = await fetch(
        `/api/admin/workspace/${workspaceId}/content-plans/${created.plan.id}/generate`,
        { method: "POST", headers: { "Content-Type": "application/json" } },
      );
      const built = (await genRes.json().catch(() => ({}))) as { plan?: ContentPlan };
      onCreated(built.plan ?? created.plan);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md border border-neutral-300 dark:border-neutral-700">
      {/* Stepper */}
      <div className="flex items-center gap-2 border-b border-neutral-200 px-4 py-3 text-sm dark:border-neutral-800">
        {STEPS.map((label, i) => (
          <div key={label} className="flex items-center gap-2">
            <span
              className={`flex h-6 w-6 items-center justify-center rounded-full text-xs ${
                i === step
                  ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"
                  : i < step
                    ? "bg-green-600 text-white"
                    : "bg-neutral-200 text-neutral-500 dark:bg-neutral-800"
              }`}
            >
              {i < step ? "✓" : i + 1}
            </span>
            <span className={i === step ? "font-medium" : "text-neutral-500"}>{label}</span>
            {i < STEPS.length - 1 ? <span className="text-neutral-300">→</span> : null}
          </div>
        ))}
      </div>

      <div className="space-y-4 p-4">
        {/* Step 0 — Strategy */}
        {step === 0 ? (
          <div className="space-y-4">
            <Field label="Workflow name">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Weekly Writing Launch"
                className={INPUT}
              />
            </Field>
            <Field label="Objective">
              <div className="grid gap-2 sm:grid-cols-3">
                {OBJECTIVES.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => setObjective(o.id)}
                    className={`rounded-md border p-3 text-left text-sm ${
                      objective === o.id
                        ? "border-neutral-900 bg-neutral-50 dark:border-white dark:bg-neutral-900"
                        : "border-neutral-300 dark:border-neutral-700"
                    }`}
                  >
                    <div className="font-medium">{o.label}</div>
                    <div className="text-xs text-neutral-500">{o.hint}</div>
                  </button>
                ))}
              </div>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Hub URL (optional)" hint="Substituted into promos as the live link.">
                <input
                  value={hubUrl}
                  onChange={(e) => setHubUrl(e.target.value)}
                  placeholder="https://…"
                  className={INPUT}
                />
              </Field>
              <Field label="Subscriber count (optional)" hint="Used in CTAs (“join 1,280 readers”).">
                <input
                  type="number"
                  min={0}
                  value={subscriberCount}
                  onChange={(e) => setSubscriberCount(e.target.value)}
                  placeholder="1280"
                  className={INPUT}
                />
              </Field>
            </div>
          </div>
        ) : null}

        {/* Step 1 — Scope */}
        {step === 1 ? (
          <div className="space-y-4">
            <Field label="Authority topics" hint="From your workspace Settings — the angles to ground + organize around.">
              {topics.length === 0 ? (
                <p className="text-xs text-neutral-500">
                  No authority topics yet — add some in the workspace Settings tab. You can still
                  continue (grounding will be global).
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {topics.map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setSelectedTopics((cur) => toggle(cur, t))}
                      className={`rounded-full border px-3 py-1 text-xs ${
                        selectedTopics.includes(t)
                          ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                          : "border-neutral-300 dark:border-neutral-700"
                      }`}
                    >
                      {contentMatrixLabel(t)}
                    </button>
                  ))}
                </div>
              )}
            </Field>
            <Field label="Spark — the angle / thesis" hint="The point of view this workflow should make.">
              <textarea
                value={spark}
                onChange={(e) => setSpark(e.target.value)}
                rows={4}
                placeholder="e.g. Founders who write weekly compound trust faster than those who run ads."
                className={INPUT}
              />
            </Field>
          </div>
        ) : null}

        {/* Step 2 — Knowledge */}
        {step === 2 ? (
          <div className="space-y-4">
            <Field label="Grounding scope">
              <div className="flex flex-wrap gap-2">
                <Radio
                  checked={groundingScope === "global"}
                  onChange={() => setGroundingScope("global")}
                  label="Global"
                  hint="All workspace knowledge"
                />
                <Radio
                  checked={groundingScope === "scoped"}
                  onChange={() => setGroundingScope("scoped")}
                  label="Scoped to topics"
                  hint={selectedTopics.length ? "Filter to the chosen topics" : "Pick topics first"}
                  disabled={selectedTopics.length === 0}
                />
              </div>
            </Field>
            <Field label="Grounding sources" hint="Only fully-vectorized (done) sources ground generation.">
              {doneSources.length === 0 ? (
                <p className="text-xs text-neutral-500">
                  No vectorized sources yet. Add one below — it becomes available here once it finishes
                  vectorizing.
                </p>
              ) : (
                <ul className="space-y-1 text-xs">
                  {doneSources.slice(0, 8).map((s) => (
                    <li key={s.id} className="flex items-center gap-2 text-neutral-600 dark:text-neutral-400">
                      <span className="text-green-600">●</span>
                      <span className="truncate">{s.sourceUri}</span>
                      {s.topic ? <span className="text-neutral-400">· {contentMatrixLabel(s.topic)}</span> : null}
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-3">
                <IngestBar workspaceId={workspaceId} onIngested={refreshSources} />
              </div>
            </Field>
            <Field label="Proof / case-study (optional)" hint="Concrete evidence to weave in (treated as facts).">
              <textarea
                value={proof}
                onChange={(e) => setProof(e.target.value)}
                rows={3}
                placeholder="e.g. Customer X grew from 0→5k subs in 90 days using this approach."
                className={INPUT}
              />
            </Field>
          </div>
        ) : null}

        {/* Step 3 — Topology */}
        {step === 3 ? (
          <div className="space-y-4">
            <Field label="Hub channel" hint="The comprehensive centerpiece.">
              <div className="flex gap-2">
                <Radio checked={hubChannel === "newsletter"} onChange={() => setHubChannel("newsletter")} label="Newsletter" />
                <Radio checked={hubChannel === "blog"} onChange={() => setHubChannel("blog")} label="Blog (SEO/GEO)" />
              </div>
            </Field>
            <Field label="Spoke channels" hint="Atomize the hub into these native formats.">
              <div className="flex flex-wrap gap-2">
                {SPOKE_OPTIONS.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setSpokeChannels((cur) => toggle(cur, c.id))}
                    className={`rounded-md border px-3 py-1.5 text-sm ${
                      spokeChannels.includes(c.id)
                        ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                        : "border-neutral-300 dark:border-neutral-700"
                    }`}
                  >
                    {channelLabel(c.id)}
                  </button>
                ))}
              </div>
            </Field>
            <p className="rounded-md bg-neutral-50 p-3 text-xs text-neutral-500 dark:bg-neutral-900/40">
              The Architect will build a canvas: a pre-hub teaser, the {hubChannel} hub,
              a post-hub promo, and one spoke per channel above — then fill each node from your
              knowledge base.
            </p>
          </div>
        ) : null}

        {err ? <p className="text-xs text-red-600 dark:text-red-400">{err}</p> : null}

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-neutral-200 pt-4 dark:border-neutral-800">
          <button
            type="button"
            onClick={step === 0 ? onCancel : () => setStep((s) => s - 1)}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            {step === 0 ? "Cancel" : "Back"}
          </button>
          {step < STEPS.length - 1 ? (
            <button
              type="button"
              onClick={next}
              className="rounded-md bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900"
            >
              Next
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={busy}
              className="rounded-md bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-60 dark:bg-white dark:text-neutral-900"
            >
              {busy ? "Building…" : "Build workflow"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const INPUT =
  "w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div>
        <div className="text-sm font-medium">{label}</div>
        {hint ? <div className="text-xs text-neutral-500">{hint}</div> : null}
      </div>
      {children}
    </div>
  );
}

function Radio({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onChange}
      disabled={disabled}
      className={`rounded-md border px-3 py-2 text-left text-sm disabled:opacity-40 ${
        checked
          ? "border-neutral-900 bg-neutral-50 dark:border-white dark:bg-neutral-900"
          : "border-neutral-300 dark:border-neutral-700"
      }`}
    >
      <div className="font-medium">{label}</div>
      {hint ? <div className="text-xs text-neutral-500">{hint}</div> : null}
    </button>
  );
}

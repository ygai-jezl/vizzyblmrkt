"use client";

import type { Node } from "@xyflow/react";
import { EmailComposer, type EmailComposerValue } from "@/components/admin/email/EmailComposer";
import type {
  JourneyBranch,
  JourneyCondition,
  ConditionOperator,
  AbTest,
  AbVariant,
} from "@/lib/types/journey";
import type { Question } from "@/lib/types/campaign";
import {
  CONDITION_FIELDS,
  CONDITION_FIELD_BY_KEY,
  OPERATOR_LABELS,
} from "@/lib/journey/conditions";

/**
 * Slide-out inspector for the selected Journey node. Email nodes host the shared
 * <EmailComposer/> (Agent 3 + merge vars); wait nodes expose a delay input;
 * condition nodes expose the branch-list editor below. Edits flow straight back
 * to the canvas via onUpdate (the graph is saved separately from the toolbar).
 */
export function NodeInspector({
  node,
  campaignId,
  questions = [],
  onUpdate,
  onDelete,
  onClose,
}: {
  node: Node;
  campaignId: string;
  questions?: Question[];
  onUpdate: (id: string, data: Record<string, unknown>) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const data = node.data as Record<string, unknown>;

  return (
    <div className="fixed inset-y-0 right-0 z-40 w-full max-w-[760px] overflow-y-auto border-l border-neutral-200 bg-white p-5 shadow-2xl dark:border-neutral-800 dark:bg-neutral-950">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-semibold capitalize">{node.type} step</h3>
        <div className="flex items-center gap-2">
          {node.type !== "trigger" ? (
            <button
              type="button"
              onClick={() => onDelete(node.id)}
              className="rounded-md border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400"
            >
              Delete
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-900"
            aria-label="Close inspector"
          >
            ✕
          </button>
        </div>
      </div>

      {node.type === "email" ? (
        <div className="space-y-4">
          <EmailComposer
            mode="journey-node"
            campaignId={campaignId}
            value={{
              subject: String(data.subject ?? ""),
              body: String(data.body ?? ""),
              heroImageUrl: (data.heroImageUrl as string | null) ?? null,
              agentMeta: data.agentMeta as EmailComposerValue["agentMeta"],
            }}
            onChange={(v) =>
              onUpdate(node.id, {
                subject: v.subject,
                body: v.body,
                heroImageUrl: v.heroImageUrl ?? null,
                agentMeta: v.agentMeta,
              })
            }
          />
          <AbTestEditor
            abTest={data.abTest as AbTest | undefined}
            campaignId={campaignId}
            onChange={(abTest) => onUpdate(node.id, { abTest })}
          />
        </div>
      ) : null}

      {node.type === "wait" ? (
        <label className="block text-xs font-medium text-neutral-600 dark:text-neutral-300">
          Wait duration (hours)
          <input
            type="number"
            min={0}
            value={Number(data.waitHours ?? 0)}
            onChange={(e) =>
              onUpdate(node.id, { waitHours: Math.max(0, Number(e.target.value) || 0) })
            }
            className="mt-1 w-32 rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
        </label>
      ) : null}

      {node.type === "condition" ? (
        <ConditionEditor
          branches={(data.branches as JourneyBranch[] | undefined) ?? []}
          questions={questions}
          onChange={(branches) => onUpdate(node.id, { branches })}
        />
      ) : null}

      {node.type === "trigger" ? (
        <p className="text-sm text-neutral-500">
          The journey starts here when a signup becomes verified. Connect this to
          the first email or wait step.
        </p>
      ) : null}
    </div>
  );
}

function newVariant(): AbVariant {
  return { variantId: `var_${crypto.randomUUID()}`, subject: "", body: "", heroImageUrl: null };
}

/**
 * A/B authoring for an email node. The node's base copy (above) is always the
 * CONTROL; this adds 1–2 challenger variants and the % of recipients that enter
 * the test (the rest get control). Results + winner promotion live in the
 * launch's Analytics → Emails tab, NOT here — authoring only.
 */
function AbTestEditor({
  abTest,
  campaignId,
  onChange,
}: {
  abTest: AbTest | undefined;
  campaignId: string;
  onChange: (next: AbTest | undefined) => void;
}) {
  // A promoted test is history — the winner is already in the base copy above.
  if (abTest?.status === "promoted") {
    return (
      <div className="mt-2 rounded-md border border-green-200 bg-green-50/60 p-3 text-xs text-green-800 dark:border-green-900 dark:bg-green-950/30 dark:text-green-300">
        A/B test promoted — the winning version is now the email above. Toggle a
        new test to run another.{" "}
        <button
          type="button"
          onClick={() => onChange(undefined)}
          className="underline"
        >
          Start a new test
        </button>
      </div>
    );
  }

  const enabled = !!abTest?.enabled;

  function enable() {
    onChange({ enabled: true, variants: [newVariant()], splitPercent: 50, status: "running" });
  }
  function setSplit(p: number) {
    if (!abTest) return;
    onChange({ ...abTest, splitPercent: Math.min(100, Math.max(1, Math.round(p) || 1)) });
  }
  function updateVariant(idx: number, patch: Partial<AbVariant>) {
    if (!abTest) return;
    onChange({
      ...abTest,
      variants: abTest.variants.map((v, i) => (i === idx ? { ...v, ...patch } : v)),
    });
  }
  function addVariant() {
    if (!abTest || abTest.variants.length >= 2) return;
    onChange({ ...abTest, variants: [...abTest.variants, newVariant()] });
  }
  function removeVariant(idx: number) {
    if (!abTest) return;
    const variants = abTest.variants.filter((_, i) => i !== idx);
    onChange(variants.length === 0 ? undefined : { ...abTest, variants });
  }

  return (
    <div className="mt-2 border-t border-neutral-200 pt-4 dark:border-neutral-800">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold">A/B test</h4>
          <p className="text-xs text-neutral-500">
            Try alternate versions of this email — the email above is the control.
          </p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-xs font-medium text-neutral-600 dark:text-neutral-300">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => (e.target.checked ? enable() : onChange(undefined))}
          />
          Run A/B test
        </label>
      </div>

      {enabled && abTest ? (
        <div className="mt-3 space-y-4">
          <label className="block text-xs font-medium text-neutral-600 dark:text-neutral-300">
            % of recipients entering the test
            <div className="mt-1 flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={100}
                value={abTest.splitPercent}
                onChange={(e) => setSplit(Number(e.target.value))}
                className="w-24 rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
              <span className="text-xs font-normal text-neutral-500">
                The other {100 - abTest.splitPercent}% get the control.
              </span>
            </div>
          </label>

          {abTest.variants.map((v, i) => (
            <div
              key={v.variantId}
              className="rounded-md border border-neutral-200 p-3 dark:border-neutral-800"
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-semibold text-neutral-500">
                  Variant {String.fromCharCode(65 + i)}
                </span>
                <button
                  type="button"
                  onClick={() => removeVariant(i)}
                  className="rounded px-1.5 py-0.5 text-xs text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950"
                >
                  Remove
                </button>
              </div>
              <EmailComposer
                mode="journey-node"
                campaignId={campaignId}
                value={{
                  subject: v.subject,
                  body: v.body,
                  heroImageUrl: v.heroImageUrl ?? null,
                }}
                onChange={(val) =>
                  updateVariant(i, {
                    subject: val.subject,
                    body: val.body,
                    heroImageUrl: val.heroImageUrl ?? null,
                  })
                }
              />
            </div>
          ))}

          {abTest.variants.length < 2 ? (
            <button
              type="button"
              onClick={addVariant}
              className="rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              + Add another variant
            </button>
          ) : null}

          <p className="rounded-md bg-neutral-50 p-2 text-xs text-neutral-500 dark:bg-neutral-900/40">
            Review results and promote a winner from this launch&apos;s{" "}
            <span className="font-medium">Analytics → Emails</span> tab once the
            test has run.
          </p>
        </div>
      ) : null}
    </div>
  );
}

const SELECT_CLASS =
  "rounded-md border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900";

/**
 * Edits a condition node's ordered branch list. Branches are checked top to
 * bottom; the first match wins. Recipients matching none take the Default
 * branch. Each branch wires from its own handle on the canvas.
 */
function ConditionEditor({
  branches,
  questions,
  onChange,
}: {
  branches: JourneyBranch[];
  questions: Question[];
  onChange: (branches: JourneyBranch[]) => void;
}) {
  // A branch's rule list: the new multi-rule `conditions`, else the legacy
  // single `condition` lifted into a 1-element list.
  const rulesOf = (b: JourneyBranch): JourneyCondition[] =>
    b.conditions ?? (b.condition ? [b.condition] : []);

  // Any edit migrates the branch to the multi-rule shape (drops legacy `condition`).
  function writeBranch(
    idx: number,
    conditions: JourneyCondition[],
    match?: "all" | "any",
  ) {
    onChange(
      branches.map((b, i) => {
        if (i !== idx) return b;
        const m = match ?? b.match;
        return {
          id: b.id,
          ...(b.label !== undefined ? { label: b.label } : {}),
          ...(m ? { match: m } : {}),
          conditions,
        };
      }),
    );
  }
  function updateRule(bIdx: number, rIdx: number, patch: Partial<JourneyCondition>) {
    writeBranch(
      bIdx,
      rulesOf(branches[bIdx]!).map((r, i) => (i === rIdx ? { ...r, ...patch } : r)),
    );
  }
  function changeField(bIdx: number, rIdx: number, fieldKey: string) {
    const key = fieldKey as JourneyCondition["field"];
    const field = CONDITION_FIELD_BY_KEY.get(key);
    if (!field) return;
    const operator: ConditionOperator = field.operators[0] ?? "eq";
    // Replace the whole rule so a stale value/questionValue can't linger.
    writeBranch(
      bIdx,
      rulesOf(branches[bIdx]!).map((r, i) => (i === rIdx ? { field: key, operator } : r)),
    );
  }
  function addRule(bIdx: number) {
    writeBranch(bIdx, [
      ...rulesOf(branches[bIdx]!),
      { field: "madeReferral", operator: "is_false" },
    ]);
  }
  function removeRule(bIdx: number, rIdx: number) {
    const rules = rulesOf(branches[bIdx]!).filter((_, i) => i !== rIdx);
    // Keep at least one rule so the branch always means something.
    writeBranch(bIdx, rules.length ? rules : [{ field: "madeReferral", operator: "is_false" }]);
  }
  function setMatch(bIdx: number, match: "all" | "any") {
    writeBranch(bIdx, rulesOf(branches[bIdx]!), match);
  }
  function addBranch() {
    onChange([
      ...branches,
      {
        id: `br_${crypto.randomUUID()}`,
        match: "all",
        conditions: [{ field: "madeReferral", operator: "is_false" }],
      },
    ]);
  }
  function removeBranch(idx: number) {
    onChange(branches.filter((_, i) => i !== idx));
  }
  function move(idx: number, dir: -1 | 1) {
    const j = idx + dir;
    if (j < 0 || j >= branches.length) return;
    const next = [...branches];
    [next[idx], next[j]] = [next[j]!, next[idx]!];
    onChange(next);
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-neutral-500">
        Branches are checked top to bottom; the first match wins. A branch can
        combine several rules. Recipients matching none take the{" "}
        <span className="font-medium">Default</span> branch — wire its handle so
        they always have a path.
      </p>

      {branches.map((b, idx) => {
        const rules = rulesOf(b);
        return (
          <div
            key={b.id}
            className="rounded-md border border-neutral-200 p-3 dark:border-neutral-800"
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold text-neutral-500">
                Branch {idx + 1}
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => move(idx, -1)}
                  disabled={idx === 0}
                  className="rounded px-1.5 py-0.5 text-xs text-neutral-500 hover:bg-neutral-100 disabled:opacity-30 dark:hover:bg-neutral-800"
                  aria-label="Move branch up"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => move(idx, 1)}
                  disabled={idx === branches.length - 1}
                  className="rounded px-1.5 py-0.5 text-xs text-neutral-500 hover:bg-neutral-100 disabled:opacity-30 dark:hover:bg-neutral-800"
                  aria-label="Move branch down"
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => removeBranch(idx)}
                  className="rounded px-1.5 py-0.5 text-xs text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950"
                  aria-label="Remove branch"
                >
                  ✕
                </button>
              </div>
            </div>

            {rules.length > 1 ? (
              <div className="mb-2 flex items-center gap-2 text-xs text-neutral-500">
                Match
                <select
                  value={b.match ?? "all"}
                  onChange={(e) => setMatch(idx, e.target.value as "all" | "any")}
                  className={SELECT_CLASS}
                >
                  <option value="all">ALL rules (AND)</option>
                  <option value="any">ANY rule (OR)</option>
                </select>
              </div>
            ) : null}

            <div className="space-y-2">
              {rules.map((rule, rIdx) => {
                const field = CONDITION_FIELD_BY_KEY.get(rule.field);
                return (
                  <div key={rIdx} className="flex flex-wrap items-center gap-2">
                    <select
                      value={rule.field}
                      onChange={(e) => changeField(idx, rIdx, e.target.value)}
                      className={SELECT_CLASS}
                    >
                      {CONDITION_FIELDS.map((f) => (
                        <option key={f.key} value={f.key}>
                          {f.label}
                        </option>
                      ))}
                    </select>

                    <select
                      value={rule.operator}
                      onChange={(e) =>
                        updateRule(idx, rIdx, {
                          operator: e.target.value as ConditionOperator,
                        })
                      }
                      className={SELECT_CLASS}
                    >
                      {(field?.operators ?? []).map((op) => (
                        <option key={op} value={op}>
                          {OPERATOR_LABELS[op]}
                        </option>
                      ))}
                    </select>

                    <ValueInput
                      field={field}
                      condition={rule}
                      questions={questions}
                      onChange={(patch) => updateRule(idx, rIdx, patch)}
                    />

                    {rules.length > 1 ? (
                      <button
                        type="button"
                        onClick={() => removeRule(idx, rIdx)}
                        className="rounded px-1.5 py-0.5 text-xs text-neutral-400 hover:bg-neutral-100 hover:text-red-600 dark:hover:bg-neutral-800"
                        aria-label="Remove rule"
                      >
                        ✕
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>

            <button
              type="button"
              onClick={() => addRule(idx)}
              className="mt-2 text-xs text-neutral-500 underline-offset-2 hover:underline"
            >
              + Add rule
            </button>
          </div>
        );
      })}

      <button
        type="button"
        onClick={addBranch}
        className="rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
      >
        + Add branch
      </button>

      <div className="rounded-md border border-dashed border-neutral-300 p-3 text-xs text-neutral-500 dark:border-neutral-700">
        <span className="font-medium">Default</span> — everyone matching none of
        the branches above. Wire its handle to give them a path (leaving it
        unconnected will block activation, so no one silently dead-ends).
      </div>
    </div>
  );
}

/** The value control for a rule, switched on the field's value type. */
function ValueInput({
  field,
  condition,
  questions,
  onChange,
}: {
  field: (typeof CONDITION_FIELDS)[number] | undefined;
  condition: JourneyCondition;
  questions: Question[];
  onChange: (patch: Partial<JourneyCondition>) => void;
}) {
  if (!field) return null;

  // Boolean fields use is_true/is_false — the operator carries the value.
  if (field.valueType === "boolean") return null;

  if (field.valueType === "number") {
    return (
      <input
        type="number"
        value={Number(condition.value ?? 0)}
        onChange={(e) => onChange({ value: Number(e.target.value) || 0 })}
        className="w-24 rounded-md border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
      />
    );
  }

  // Survey answer: pick the question, then the answer (configured options if any).
  if (field.needsQuestion) {
    const q = questions.find((x) => x.question_value === condition.questionValue);
    const options = q?.answer_value ?? null;
    return (
      <>
        <select
          value={condition.questionValue ?? ""}
          onChange={(e) =>
            onChange({ questionValue: e.target.value, value: undefined })
          }
          className={SELECT_CLASS}
        >
          <option value="">Select question…</option>
          {questions.map((x) => (
            <option key={x.question_value} value={x.question_value}>
              {x.question_value}
            </option>
          ))}
        </select>
        {options && options.length > 0 ? (
          <select
            value={String(condition.value ?? "")}
            onChange={(e) => onChange({ value: e.target.value })}
            className={SELECT_CLASS}
          >
            <option value="">Select answer…</option>
            {options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            value={String(condition.value ?? "")}
            onChange={(e) => onChange({ value: e.target.value })}
            placeholder="answer"
            className="w-40 rounded-md border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
        )}
      </>
    );
  }

  // Plain string field.
  return (
    <input
      type="text"
      value={String(condition.value ?? "")}
      onChange={(e) => onChange({ value: e.target.value })}
      placeholder="value"
      className="w-40 rounded-md border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
    />
  );
}

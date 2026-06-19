"use client";

import type { Node } from "@xyflow/react";
import { EmailComposer, type EmailComposerValue } from "@/components/admin/email/EmailComposer";
import type {
  JourneyBranch,
  JourneyCondition,
  ConditionOperator,
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
  function updateRule(idx: number, patch: Partial<JourneyCondition>) {
    onChange(
      branches.map((b, i) =>
        i === idx ? { ...b, condition: { ...b.condition, ...patch } } : b,
      ),
    );
  }
  function changeField(idx: number, fieldKey: string) {
    const field = CONDITION_FIELD_BY_KEY.get(fieldKey);
    if (!field) return;
    const operator: ConditionOperator = field.operators[0] ?? "eq";
    // Replace the whole rule so stale value/questionValue don't linger.
    onChange(
      branches.map((b, i) =>
        i === idx ? { ...b, condition: { field: fieldKey, operator } } : b,
      ),
    );
  }
  function addBranch() {
    onChange([
      ...branches,
      {
        id: `br_${crypto.randomUUID()}`,
        condition: { field: "madeReferral", operator: "is_false" },
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
        Branches are checked top to bottom; the first match wins. Recipients
        matching none take the <span className="font-medium">Default</span>{" "}
        branch. Wire each branch&apos;s handle to the next step.
      </p>

      {branches.map((b, idx) => {
        const field = CONDITION_FIELD_BY_KEY.get(b.condition.field);
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

            <div className="flex flex-wrap items-center gap-2">
              <select
                value={b.condition.field}
                onChange={(e) => changeField(idx, e.target.value)}
                className={SELECT_CLASS}
              >
                {CONDITION_FIELDS.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
              </select>

              <select
                value={b.condition.operator}
                onChange={(e) =>
                  updateRule(idx, {
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
                condition={b.condition}
                questions={questions}
                onChange={(patch) => updateRule(idx, patch)}
              />
            </div>
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
        the branches above. Wire its handle to give them a path (or leave it
        unconnected to end their journey here).
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

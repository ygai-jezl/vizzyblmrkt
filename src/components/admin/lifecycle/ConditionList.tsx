"use client";

import { Plus, X } from "lucide-react";
import type { LifecycleCondition } from "@/lib/types/lifecycle";
import { fieldKind, OPERATORS, type FieldOption } from "./model";
import { Button, inputClass } from "../connect/ui";

/**
 * Edit a list of lifecycle conditions against the connection's catalog. A
 * `fact.*` field can be typed in (facts come from the product's context, so
 * they aren't in the catalog). Unknown values never match — see fields.ts.
 */
export function ConditionList({
  conditions,
  fields,
  onChange,
  disabled,
  max = 10,
}: {
  conditions: LifecycleCondition[];
  fields: FieldOption[];
  onChange: (next: LifecycleCondition[]) => void;
  disabled?: boolean;
  max?: number;
}) {
  const groups = [...new Set(fields.map((f) => f.group))];
  const set = (i: number, patch: Partial<LifecycleCondition>) =>
    onChange(conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  const changeField = (i: number, field: string) => {
    const kind = fieldKind(field, fields);
    const operator = OPERATORS[kind][0]!.value;
    set(i, { field, operator, value: kind === "boolean" ? undefined : kind === "number" ? 0 : "" });
  };

  return (
    <div className="space-y-2">
      {conditions.map((c, i) => {
        const known = fields.some((f) => f.value === c.field);
        const kind = fieldKind(c.field, fields);
        const needsValue = c.operator !== "is_true" && c.operator !== "is_false";
        return (
          <div key={i} className="flex flex-wrap items-center gap-1.5">
            <select
              className={`${inputClass} w-auto min-w-40 flex-1`}
              value={known ? c.field : "__fact"}
              disabled={disabled}
              onChange={(e) => changeField(i, e.target.value === "__fact" ? "fact.score" : e.target.value)}
              aria-label="Field"
            >
              {groups.map((g) => (
                <optgroup key={g} label={g}>
                  {fields
                    .filter((f) => f.group === g)
                    .map((f) => (
                      <option key={f.value} value={f.value}>
                        {f.label}
                      </option>
                    ))}
                </optgroup>
              ))}
              <optgroup label="From the product's context">
                <option value="__fact">Fact…</option>
              </optgroup>
            </select>
            {!known ? (
              <input
                className={`${inputClass} w-36 font-mono text-xs`}
                value={c.field}
                disabled={disabled}
                onChange={(e) => set(i, { field: e.target.value.trim() })}
                placeholder="fact.share_of_voice"
                aria-label="Fact field"
              />
            ) : null}
            <select
              className={`${inputClass} w-auto`}
              value={c.operator}
              disabled={disabled}
              onChange={(e) => set(i, { operator: e.target.value as LifecycleCondition["operator"] })}
              aria-label="Operator"
            >
              {OPERATORS[kind].map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {needsValue ? (
              <input
                className={`${inputClass} w-28`}
                value={c.value === undefined ? "" : String(c.value)}
                disabled={disabled}
                inputMode={kind === "number" ? "decimal" : undefined}
                onChange={(e) => {
                  const raw = e.target.value;
                  const n = Number(raw);
                  set(i, { value: kind === "number" && raw.trim() !== "" && Number.isFinite(n) ? n : raw });
                }}
                aria-label="Value"
              />
            ) : null}
            <button
              type="button"
              className="rounded p-1 text-neutral-400 hover:text-red-600 disabled:opacity-40"
              onClick={() => onChange(conditions.filter((_, j) => j !== i))}
              disabled={disabled}
              aria-label="Remove condition"
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
      {conditions.length < max ? (
        <Button
          disabled={disabled}
          onClick={() => onChange([...conditions, { field: "onboarding.complete", operator: "is_true" }])}
        >
          <Plus size={14} /> Condition
        </Button>
      ) : null}
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { ReadOnlyValue, VoiceChatSummary } from "@/lib/audience/readOnlyFields";
import { FORMER_TEAM_MEMBER } from "@/lib/team/former";
import { liveOptions, optionLabel, sameFieldValue, type FieldValue, type FieldValues, type RecordField, type RecordFieldObject } from "@/lib/types/recordField";
import { Banner, Button, inputClass, Section } from "../connect/ui";
import { day, dayTime } from "../people/format";
import { fieldErrorText, loadFieldLists, saveFieldValues, type Team } from "./fieldsApi";
import { VoiceChatDialog } from "./VoiceChatDialog";

/**
 * The Fields panel (AUDIENCE_FIELDS_ENABLED) on a person's page and a company's: the brand's own
 * fields in use, which admins edit in place and members read, then the fields from elsewhere,
 * read only, with where each comes from, and a person's voice chats. Archived fields are hidden;
 * their values stay on the record and in the export.
 */

/** A day stored as YYYY-MM-DD, shown as a day whatever the viewer's time zone. */
const calendarDay = (v: string) => day(`${v}T12:00:00.000Z`, "UTC");

function shown(field: RecordField, value: FieldValue | undefined, team: Team): string | null {
  if (value === undefined || value === null) return null;
  switch (field.type) {
    case "select":
    case "status":
      return optionLabel(field, String(value)) ?? "An option no longer in use";
    case "multi_select":
      return (Array.isArray(value) ? value : [value]).map((id) => optionLabel(field, String(id)) ?? "An option no longer in use").join(", ");
    case "checkbox":
      return value ? "Yes" : "No";
    case "currency":
      return typeof value === "number" ? `${(value / 100).toFixed(2)} ${field.currency ?? ""}`.trim() : String(value);
    case "date":
      return calendarDay(String(value));
    case "team_member":
      return team.find((m) => m.id === value)?.name ?? FORMER_TEAM_MEMBER;
    default:
      return String(value);
  }
}

export function FieldsPanel({
  object,
  recordId,
  initialValues,
  readOnly = [],
  voiceChats = [],
  canEdit,
  title = "Fields",
}: {
  object: RecordFieldObject;
  recordId: string;
  initialValues: FieldValues;
  readOnly?: ReadOnlyValue[];
  voiceChats?: VoiceChatSummary[];
  canEdit: boolean;
  title?: string;
}) {
  const [fields, setFields] = useState<RecordField[] | null>(null);
  const [team, setTeam] = useState<Team>([]);
  const [values, setValues] = useState<FieldValues>(initialValues);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState<string | null>(null);

  useEffect(() => {
    void loadFieldLists().then((r) => {
      if (!r.ok) return setError("Couldn’t load the fields. Reload the page to try again.");
      setFields(r.data.lists[object].items.filter((f) => !f.archivedAt));
      setTeam(r.data.team);
    });
  }, [object]);

  async function save(field: RecordField, value: unknown) {
    setError(null);
    const r = await saveFieldValues(object, recordId, { [field.key]: value });
    if (!r.ok) return setError(fieldErrorText(r.data));
    setValues(r.data.values);
    setEditing(null);
  }

  return (
    <Section
      title={title}
      actions={
        <Link href="/admin/account/data-model" className="text-xs underline underline-offset-2">
          Manage fields
        </Link>
      }
    >
      {error ? <Banner tone="err">{error}</Banner> : null}
      {!fields ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : fields.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No fields of your own yet. {canEdit ? "Add them in Settings, under Data model." : "An admin can add them in Settings, under Data model."}
        </p>
      ) : (
        <dl className="divide-y divide-neutral-100 text-sm dark:divide-neutral-900">
          {fields.map((f) => (
            <div key={f.key} className="flex flex-wrap items-start gap-x-4 gap-y-1 py-2">
              <dt className="w-40 shrink-0 text-neutral-500">{f.label}</dt>
              <dd className="min-w-0 flex-1 break-words">
                {editing === f.key ? (
                  <ValueEditor field={f} value={values[f.key]} team={team} onSave={(v) => void save(f, v)} onCancel={() => setEditing(null)} />
                ) : (
                  (shown(f, values[f.key], team) ?? <span className="text-neutral-400">None set</span>)
                )}
              </dd>
              {canEdit && editing !== f.key ? (
                <button type="button" className="text-xs underline underline-offset-2" onClick={() => setEditing(f.key)} aria-label={`Edit ${f.label}`}>
                  Edit
                </button>
              ) : null}
            </div>
          ))}
        </dl>
      )}

      {readOnly.length || voiceChats.length ? (
        <div className="space-y-2 border-t border-neutral-100 pt-3 dark:border-neutral-900">
          <h4 className="text-xs font-medium text-neutral-500">From elsewhere, read only</h4>
          <dl className="space-y-2 text-sm">
            {readOnly.map((v) => (
              <div key={v.key} className="flex flex-wrap gap-x-4">
                <dt className="w-40 shrink-0 text-neutral-500">{v.label}</dt>
                <dd className="min-w-0 flex-1 break-words">
                  {v.kind === "time" ? dayTime(v.value) : v.value}
                  <span className="block text-xs text-neutral-500">{v.source}</span>
                </dd>
              </div>
            ))}
            {voiceChats.map((c) => (
              <div key={c.signupId} className="flex flex-wrap gap-x-4">
                <dt className="w-40 shrink-0 text-neutral-500">Voice chat</dt>
                <dd className="min-w-0 flex-1 space-y-0.5 break-words">
                  <span className="block">Completed on {day(c.at)}</span>
                  {c.summary ? <q className="block italic">{c.summary}</q> : null}
                  <span className="block text-xs text-neutral-500">
                    {c.summary ? "Summary sent by their browser. " : ""}
                    {canEdit && c.turns > 0 ? (
                      <button type="button" className="underline underline-offset-2" onClick={() => setReading(c.signupId)}>
                        Read the conversation
                      </button>
                    ) : null}
                  </span>
                  <span className="block text-xs text-neutral-500">{c.launchName} sign-up page</span>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      {reading ? <VoiceChatDialog personId={recordId} signupId={reading} onClose={() => setReading(null)} /> : null}
    </Section>
  );
}

/** One value's editor, by its field's type: the input, then Save and Cancel. */
function ValueEditor({
  field,
  value,
  team,
  onSave,
  onCancel,
}: {
  field: RecordField;
  value: FieldValue | undefined;
  team: Team;
  onSave: (value: unknown) => void;
  onCancel: () => void;
}) {
  const [current, setCurrent] = useState<unknown>(value ?? null);
  const unchanged = sameFieldValue((value ?? null) as FieldValue | null, current as FieldValue | null);
  return (
    <span className="flex flex-col gap-2">
      <FieldInput field={field} value={value} team={team} onChange={setCurrent} />
      <span className="flex gap-2">
        <Button tone="primary" disabled={unchanged} onClick={() => onSave(current)}>
          Save
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </span>
    </span>
  );
}

/**
 * One field's input, by its type, reporting the value as the writer takes it (null for none) on
 * every change. The Fields panel and the New person form share it.
 */
export function FieldInput({
  field,
  value,
  team,
  onChange,
}: {
  field: RecordField;
  value: FieldValue | undefined;
  team: Team;
  onChange: (value: unknown) => void;
}) {
  const initial = (): string => {
    if (value === undefined || value === null) return "";
    if (field.type === "currency" && typeof value === "number") return (value / 100).toFixed(2);
    return Array.isArray(value) ? "" : String(value);
  };
  const [text, setText] = useState(initial);
  const [picked, setPicked] = useState<string[]>(Array.isArray(value) ? value : []);
  const [checked, setChecked] = useState(value === true);

  const out = (next: { text?: string; picked?: string[]; checked?: boolean }): unknown => {
    const t = next.text ?? text;
    switch (field.type) {
      case "checkbox":
        return next.checked ?? checked;
      case "multi_select": {
        const p = next.picked ?? picked;
        return p.length ? p : null;
      }
      case "number":
        return t.trim() === "" ? null : Number(t);
      case "currency":
        return t.trim() === "" ? null : Math.round(Number(t) * 100);
      default:
        return t.trim() === "" ? null : t;
    }
  };
  const typed = (t: string) => {
    setText(t);
    onChange(out({ text: t }));
  };
  const ticked = (c: boolean) => {
    setChecked(c);
    onChange(out({ checked: c }));
  };
  const toggled = (id: string, on: boolean) => {
    const p = on ? [...picked, id] : picked.filter((x) => x !== id);
    setPicked(p);
    onChange(out({ picked: p }));
  };

  switch (field.type) {
    case "checkbox":
      return (
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={checked} onChange={(e) => ticked(e.target.checked)} /> {field.label}
        </label>
      );
    case "select":
    case "status":
      return (
        <select value={text} onChange={(e) => typed(e.target.value)} className={inputClass} aria-label={field.label}>
          <option value="">None</option>
          {liveOptions(field).map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case "multi_select":
      return (
        <span className="flex flex-wrap gap-2" role="group" aria-label={field.label}>
          {liveOptions(field).map((o) => (
            <label key={o.id} className="flex items-center gap-1">
              <input type="checkbox" checked={picked.includes(o.id)} onChange={(e) => toggled(o.id, e.target.checked)} />
              {o.label}
            </label>
          ))}
        </span>
      );
    case "team_member":
      return (
        <select value={text} onChange={(e) => typed(e.target.value)} className={inputClass} aria-label={field.label}>
          <option value="">Nobody</option>
          {team.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
          {text && !team.some((m) => m.id === text) ? <option value={text}>{FORMER_TEAM_MEMBER}</option> : null}
        </select>
      );
    case "text":
      return <textarea value={text} rows={2} maxLength={2000} onChange={(e) => typed(e.target.value)} className={inputClass} aria-label={field.label} />;
    default: {
      const type = { number: "number", currency: "number", date: "date", email: "email", phone: "tel", link: "url" }[field.type as string] ?? "text";
      return (
        <span className="flex items-center gap-1.5">
          <input
            type={type}
            step={field.type === "currency" ? "0.01" : field.type === "number" ? "any" : undefined}
            value={text}
            onChange={(e) => typed(e.target.value)}
            className={inputClass}
            aria-label={field.label}
          />
          {field.type === "currency" ? <span className="text-xs text-neutral-500">{field.currency}</span> : null}
        </span>
      );
    }
  }
}

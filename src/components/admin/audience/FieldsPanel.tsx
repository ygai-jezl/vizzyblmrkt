"use client";

import { useEffect, useState, type ReactNode } from "react";
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

/** One value's editor, by its field's type. */
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
  const initial = (): string => {
    if (value === undefined || value === null) return "";
    if (field.type === "currency" && typeof value === "number") return (value / 100).toFixed(2);
    return Array.isArray(value) ? "" : String(value);
  };
  const [text, setText] = useState(initial);
  const [picked, setPicked] = useState<string[]>(Array.isArray(value) ? value : []);
  const [checked, setChecked] = useState(value === true);

  const out = (): unknown => {
    switch (field.type) {
      case "checkbox":
        return checked;
      case "multi_select":
        return picked.length ? picked : null;
      case "number":
        return text.trim() === "" ? null : Number(text);
      case "currency":
        return text.trim() === "" ? null : Math.round(Number(text) * 100);
      default:
        return text.trim() === "" ? null : text;
    }
  };
  const unchanged = sameFieldValue((value ?? null) as FieldValue | null, out() as FieldValue | null);

  let input: ReactNode;
  switch (field.type) {
    case "checkbox":
      input = (
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> {field.label}
        </label>
      );
      break;
    case "select":
    case "status":
      input = (
        <select value={text} onChange={(e) => setText(e.target.value)} className={inputClass} aria-label={field.label}>
          <option value="">None</option>
          {liveOptions(field).map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      );
      break;
    case "multi_select":
      input = (
        <span className="flex flex-wrap gap-2" role="group" aria-label={field.label}>
          {liveOptions(field).map((o) => (
            <label key={o.id} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={picked.includes(o.id)}
                onChange={(e) => setPicked((cur) => (e.target.checked ? [...cur, o.id] : cur.filter((x) => x !== o.id)))}
              />
              {o.label}
            </label>
          ))}
        </span>
      );
      break;
    case "team_member":
      input = (
        <select value={text} onChange={(e) => setText(e.target.value)} className={inputClass} aria-label={field.label}>
          <option value="">Nobody</option>
          {team.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
          {text && !team.some((m) => m.id === text) ? <option value={text}>{FORMER_TEAM_MEMBER}</option> : null}
        </select>
      );
      break;
    case "text":
      input = <textarea value={text} rows={2} maxLength={2000} onChange={(e) => setText(e.target.value)} className={inputClass} aria-label={field.label} />;
      break;
    default: {
      const type = { number: "number", currency: "number", date: "date", email: "email", phone: "tel", link: "url" }[field.type as string] ?? "text";
      input = (
        <span className="flex items-center gap-1.5">
          <input
            type={type}
            step={field.type === "currency" ? "0.01" : field.type === "number" ? "any" : undefined}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className={inputClass}
            aria-label={field.label}
          />
          {field.type === "currency" ? <span className="text-xs text-neutral-500">{field.currency}</span> : null}
        </span>
      );
    }
  }

  return (
    <span className="flex flex-col gap-2">
      {input}
      <span className="flex gap-2">
        <Button tone="primary" disabled={unchanged} onClick={() => onSave(out())}>
          Save
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </span>
    </span>
  );
}

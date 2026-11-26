"use client";

import { useState, type FormEvent } from "react";
import { SAVED_VIEW_LIMITS, type ViewScope } from "@/lib/types/savedView";
import type { ViewDefinition } from "@/lib/views/types";
import { filterInWords, sortInWords, VIEW_MESSAGES, type ViewNames } from "@/lib/views/words";
import { Banner, Button, inputClass } from "../connect/ui";
import { Modal } from "../email/Modal";

/**
 * Save view (CRM_VIEWS_ENABLED): a name, and who can use it: Everyone on the team (admins; each
 * change is kept in the settings history) or Only me (anyone). It says what the view keeps, and that
 * the search box isn't saved. With `renaming`, only the name.
 */
export function SaveViewDialog({
  title,
  definition,
  names,
  isAdmin,
  initialName = "",
  initialScope,
  renaming = false,
  onCancel,
  onSave,
}: {
  title: string;
  definition: ViewDefinition;
  names: ViewNames;
  isAdmin: boolean;
  initialName?: string;
  initialScope?: ViewScope;
  renaming?: boolean;
  onCancel: () => void;
  /** Saves; answers a message to show when it couldn't. */
  onSave: (name: string, scope: ViewScope) => Promise<string | null>;
}) {
  const [name, setName] = useState(initialName);
  const [scope, setScope] = useState<ViewScope>(initialScope ?? (isAdmin ? "team" : "me"));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || name.trim().length > SAVED_VIEW_LIMITS.nameChars) return setError(VIEW_MESSAGES.invalid_name);
    setSaving(true);
    const problem = await onSave(name.trim(), scope);
    setSaving(false);
    if (problem) setError(problem);
  }

  const radio = (value: ViewScope, label: string, hint: string, disabled = false) => (
    <label
      className={`flex gap-2 rounded-md border p-3 ${scope === value ? "border-neutral-900 dark:border-white" : "border-neutral-200 dark:border-neutral-800"} ${disabled ? "opacity-60" : "cursor-pointer"}`}
    >
      <input type="radio" name="scope" value={value} checked={scope === value} disabled={disabled} onChange={() => setScope(value)} className="mt-0.5" />
      <span>
        <span className="block font-medium">{label}</span>
        <span className="block text-xs text-neutral-500">{hint}</span>
      </span>
    </label>
  );

  return (
    <Modal open onClose={onCancel} title={title}>
      <form onSubmit={(e) => void submit(e)} className="space-y-4 text-sm" noValidate>
        <label className="block space-y-1">
          <span className="font-medium">Name</span>
          <input autoFocus value={name} maxLength={SAVED_VIEW_LIMITS.nameChars} onChange={(e) => setName(e.target.value)} className={inputClass} />
        </label>
        {renaming ? null : (
          <>
            <fieldset className="space-y-2">
              <legend className="mb-1 font-medium">Who can use it</legend>
              {radio("team", "Everyone on the team", isAdmin ? "Admins can change it. Each change is kept in the settings history." : VIEW_MESSAGES.admins_only, !isAdmin)}
              {radio("me", "Only me", "Only you see it.")}
            </fieldset>
            <div className="rounded-md bg-neutral-50 p-3 text-xs text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400">
              <p>What it keeps:</p>
              <ul className="ml-4 list-disc">
                <li>
                  {definition.filters.length === 0
                    ? "No filters: everyone"
                    : `${definition.filters.length} ${definition.filters.length === 1 ? "filter" : "filters"}${definition.filters.length > 1 ? (definition.match === "any" ? ", any of these" : "") : ""}: ${definition.filters.map((f) => filterInWords(f, names)).join(", ")}`}
                </li>
                <li>Sorted by {sortInWords(definition.sort, names).replace(/^Most/, "most")}</li>
                <li>{definition.columns.length} columns</li>
              </ul>
              <p>The search box isn&rsquo;t saved.</p>
            </div>
          </>
        )}
        {error ? <Banner tone="err">{error}</Banner> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onCancel}>Cancel</Button>
          <Button tone="primary" type="submit" disabled={saving}>
            {saving ? "Saving…" : renaming ? "Rename" : "Save view"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

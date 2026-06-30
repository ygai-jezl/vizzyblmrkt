"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Inline "create workspace" form. POSTs /api/admin/workspace then navigates in. */
export function NewWorkspaceForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        workspace?: { id: string };
        error?: string;
      };
      if (!res.ok || !data.workspace) {
        setError(data.error ?? "Could not create the workspace. Please try again.");
        return;
      }
      router.push(`/admin/workspace/${data.workspace.id}/curate`);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-md border border-neutral-900 bg-neutral-900 px-3 py-2 text-sm text-white hover:opacity-90 dark:border-white dark:bg-white dark:text-neutral-900"
      >
        + New workspace
      </button>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-md border border-neutral-300 p-4 dark:border-neutral-700"
    >
      <div className="space-y-1">
        <label className="block text-sm font-medium">Workspace name</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Solo Newsletter"
          className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
      </div>
      <div className="space-y-1">
        <label className="block text-sm font-medium">Description (optional)</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
      </div>
      {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy || !name.trim()}
          className="rounded-md border border-neutral-900 bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:border-white dark:bg-white dark:text-neutral-900"
        >
          {busy ? "Creating…" : "Create workspace"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

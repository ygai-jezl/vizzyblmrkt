"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Sparkles } from "lucide-react";
import { Button, inputClass } from "@/components/admin/connect/ui";
import { useShell } from "@/components/admin/nav/ShellProvider";
import { COMPANY_STAGES, type CompanyStage } from "@/lib/work/stages";
import { addedLine, WORK_COPY } from "@/lib/work/screenWords";
import { WORK_LIMITS } from "@/lib/work/types";
import { workCall, workErrorText } from "./api";

/**
 * Quick add on the list: a title and an optional stage. The task is tagged with the brand the list
 * is filtered to, else where the server puts it (a member's own brand, a one brand organisation's
 * brand, or the whole business for an owner). The full form is on the add page.
 */
export function QuickAdd({ brandId, open: startOpen = false }: { brandId?: string | null; open?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(startOpen);
  const [title, setTitle] = useState("");
  const [stage, setStage] = useState<CompanyStage | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<{ ref: number; title: string } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    setError(null);
    const r = await workCall<{ task: { task: { ref: number; title: string } } }>("/tasks", "POST", {
      title: t,
      ...(stage ? { stage } : {}),
      ...(brandId !== undefined ? { brandId } : {}),
      via: "quick_add",
    });
    setBusy(false);
    if (!r.ok) return setError(workErrorText(r.data));
    setAdded({ ref: r.data.task.task.ref, title: r.data.task.task.title });
    setTitle("");
    setStage("");
    router.refresh();
  }

  if (!open) {
    return (
      <Button tone="primary" onClick={() => setOpen(true)}>
        <Plus size={16} aria-hidden />
        Add task
      </Button>
    );
  }
  return (
    <div className="w-full space-y-2">
      <form role="group" aria-label="Add a task" onSubmit={submit} className="flex flex-wrap items-center gap-2 rounded-md border border-neutral-200 p-2 dark:border-neutral-800">
        <input
          type="text"
          aria-label="Task"
          autoFocus
          maxLength={WORK_LIMITS.title}
          placeholder={WORK_COPY.quickAddPlaceholder}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className={`${inputClass} min-w-[16rem] flex-1`}
        />
        <select aria-label="Stage" value={stage} onChange={(e) => setStage(e.target.value as CompanyStage | "")} className={`${inputClass} w-auto`}>
          <option value="">No stage</option>
          {COMPANY_STAGES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.n} {s.label}
            </option>
          ))}
        </select>
        <Button type="submit" tone="primary" disabled={busy || !title.trim()}>
          {busy ? "Adding…" : "Add"}
        </Button>
        <Button onClick={() => setOpen(false)}>Cancel</Button>
        <Link href="/admin/work/new" className="text-sm text-neutral-500 underline underline-offset-4 hover:text-neutral-800 dark:text-neutral-400">
          Open the full form
        </Link>
      </form>
      {error ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : null}
      {added ? (
        <p role="status" className="text-sm text-neutral-600 dark:text-neutral-300">
          {addedLine(added.ref, added.title)}{" "}
          <Link href={`/admin/work/${added.ref}`} className="font-medium underline underline-offset-4">
            Open it
          </Link>
        </p>
      ) : null}
    </div>
  );
}

/** Ask Vizzy for a start (Vizzy's Work tools on): it suggests tasks, and they wait in Review. */
export function AskVizzyForTasks() {
  const shell = useShell();
  if (!shell) return null;
  return (
    <Button onClick={() => shell.ask("Suggest next tasks")}>
      <Sparkles size={14} aria-hidden />
      Suggest tasks
    </Button>
  );
}

"use client";

import { useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { Button, inputClass } from "@/components/admin/connect/ui";
import { chipToneClass } from "@/components/admin/people/Chip";
import { blankCheck, checkInputOf, draftOfMeasureInput, measureInputOf, measureProblems, type CheckDraft, type MeasureDraft } from "@/lib/work/form";
import { startingMeasureOf } from "@/lib/work/suggestion";
import type { MeasureInput } from "@/lib/work/inputs";
import type { AgentActionId } from "@/lib/types/agentAction";
import { suggestMeasureKind } from "@/lib/work/measureKind";
import { addedLine, brandHint, nextRefLine, suggestionFromLine, vizzyWroteLine, WORK_COPY, WORK_STATUS_TONE } from "@/lib/work/screenWords";
import { COMPANY_STAGES, type CompanyStage } from "@/lib/work/stages";
import { WORK_LIMITS, WORK_STATUSES, type MeasureKind, type TypedLink, type WorkLink, type WorkStatus } from "@/lib/work/types";
import { WORK_STATUS_LABEL } from "@/lib/work/words";
import type { AddScreen, BrandOption } from "@/lib/work/screens";
import { workCall, workErrorText } from "./api";
import { MeasurePicker } from "./MeasurePicker";
import { BlockedByPicker, CheckPicker, FreeLinksEditor, TypedLinksEditor } from "./TaskFields";

/** What Edit then add fills the form with (Review, group 4): Vizzy's suggestion, kept beside what the person adds. */
export interface SuggestionFill {
  /** The suggestion, and its rev as the person saw it: adding sends both, and the server checks them. */
  actionId: AgentActionId;
  rev: number;
  title: string;
  description: string;
  stage: CompanyStage | null;
  brandId: string | null;
  typedLinks: TypedLink[];
  /** Vizzy's proposed kind and its reason. */
  proposed: { kind: MeasureKind; reason: string } | null;
  /** How we'll know it worked, as Vizzy would set it. */
  measure: MeasureInput | null;
  /** Where Vizzy wrote it from, such as "from today's log". */
  from: string;
}

export interface TaskFormProps {
  screen: Pick<AddScreen, "nextRef" | "defaultBrandId" | "options" | "multiBrand" | "oneBrand" | "sessionBrand" | "ideaWords">;
  suggestion?: SuggestionFill | null;
  /** Where Cancel goes: the list, or Review for Edit then add. */
  cancelHref?: string;
}

const RADIO = (on: boolean, tone: string) =>
  `rounded-md border px-2.5 py-1 text-sm ${on ? `border-neutral-900 font-medium dark:border-white ${tone}` : "border-neutral-300 dark:border-neutral-700"}`;

/**
 * What the add page does once a task is added. The plain add page reads itself again, for the
 * next ref. Edit then add doesn't: its address names a suggestion that is decided now, and reading
 * it again would swap the done note for a refusal. It moves the address to the plain add page
 * instead (no read), so a reload opens a fresh form, and Add another reads that page.
 */
export function afterAddSteps(fromSuggestion: boolean): { refresh: boolean; address: string | null; refreshOnAnother: boolean } {
  return fromSuggestion ? { refresh: false, address: "/admin/work/new", refreshOnAnother: true } : { refresh: true, address: null, refreshOnAnother: false };
}

/** The brand a measure counts for: the one picked, or in a one brand organisation the one brand. */
export function measureBrandOf(brands: readonly BrandOption[], brandId: string | null, oneBrand: boolean): BrandOption | null {
  if (brandId) return brands.find((b) => b.id === brandId) ?? null;
  return oneBrand ? (brands[0] ?? null) : null;
}

/**
 * The add page (/admin/work/new): the full form. Title, description, status, Connected to and Other
 * links, then stage, brand, Must have, what it waits for, the check and How we'll know it worked. The
 * kind of win is suggested as the person types; the server works it out again on save, and sets the
 * origin, so nothing here can claim Vizzy wrote it.
 */
export function TaskForm(props: TaskFormProps) {
  // Add another starts a fresh form, the person's own.
  const [round, setRound] = useState(0);
  return <TaskFormRound key={round} {...props} suggestion={round ? null : props.suggestion} onAnother={() => setRound(round + 1)} />;
}

function TaskFormRound({ screen, suggestion = null, cancelHref = "/admin/work", onAnother }: TaskFormProps & { onAnother: () => void }) {
  const router = useRouter();
  const { options } = screen;
  const [title, setTitle] = useState(suggestion?.title ?? "");
  const [description, setDescription] = useState(suggestion?.description ?? "");
  const [status, setStatus] = useState<WorkStatus>("todo");
  const [stage, setStage] = useState<CompanyStage | null>(suggestion?.stage ?? null);
  const [brandId, setBrandId] = useState<string | null>(suggestion ? suggestion.brandId : screen.defaultBrandId);
  const [mustHave, setMustHave] = useState(false);
  const [typed, setTyped] = useState<TypedLink[]>(suggestion?.typedLinks ?? []);
  const [links, setLinks] = useState<WorkLink[]>([]);
  const [blockedBy, setBlockedBy] = useState<number[]>([]);
  const [check, setCheck] = useState<CheckDraft>(blankCheck());
  // What Add to Work would keep: a kind-only suggestion starts with no kind picked, its kind marked Vizzy suggests.
  const [measure, setMeasure] = useState<MeasureDraft>(() => draftOfMeasureInput(suggestion ? startingMeasureOf(suggestion) : null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ ref: number; title: string; notice: string | null } | null>(null);

  const brand = measureBrandOf(options.brands, brandId, screen.oneBrand);
  const zoneBrand = brand ?? options.brands.find((b) => b.id === screen.sessionBrand.id) ?? options.brands[0];
  const repos = brand ? brand.repos : options.brands.flatMap((b) => b.repos);
  const rule = useMemo(
    () => suggestMeasureKind({ title, description, stage, brandId, typedLinks: typed, oneBrand: screen.oneBrand, ideaWords: screen.ideaWords }),
    [title, description, stage, brandId, typed, screen.oneBrand, screen.ideaWords],
  );
  const proposed = suggestion?.proposed ?? rule;
  const checkInput = checkInputOf(check, zoneBrand?.today ?? "");
  const problems = measureProblems(measure);
  const titleWas = suggestion && title.trim() !== suggestion.title ? suggestion.title : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim() || busy || problems.length || checkInput === undefined) return;
    setBusy(true);
    setError(null);
    const m = measureInputOf(measure);
    const body = {
      title: title.trim(),
      ...(description.trim() ? { description } : {}),
      status,
      stage,
      mustHave,
      // Edit then add always says the brand, so a whole business suggestion stays one unless changed.
      ...(screen.multiBrand || suggestion ? { brandId } : {}),
      links,
      blockedBy,
      typedLinks: typed,
      ...(m ? { measure: m } : {}),
      ...(checkInput ? { check: checkInput } : {}),
      via: "work_page" as const,
    };
    // Edit then add: the task and the suggestion's result are written together, the origin set by the server.
    const r = suggestion
      ? await workCall<{ task: { task: { ref: number; title: string } }; notice: string | null }>(`/suggestions/${encodeURIComponent(suggestion.actionId)}`, "POST", { decision: "add", rev: suggestion.rev, task: body })
      : await workCall<{ task: { task: { ref: number; title: string } }; notice: string | null }>("/tasks", "POST", body);
    setBusy(false);
    if (!r.ok) return setError(workErrorText(r.data));
    setDone({ ref: r.data.task.task.ref, title: r.data.task.task.title, notice: r.data.notice ?? null });
    const next = afterAddSteps(suggestion !== null);
    // null state: Next.js keeps its own and moves its router to the new address without a read.
    if (next.address) window.history.replaceState(null, "", next.address);
    if (next.refresh) router.refresh();
  }

  const another = () => {
    onAnother();
    if (afterAddSteps(suggestion !== null).refreshOnAnother) router.refresh();
  };

  if (done) {
    return (
      <div role="status" className="space-y-3 rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-900 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200">
        <p className="font-medium">
          {addedLine(done.ref, done.title)} {done.notice ?? ""}
        </p>
        <span className="flex flex-wrap gap-3">
          <Link href={`/admin/work/${done.ref}`} className="font-medium underline underline-offset-4">
            Open it
          </Link>
          <Link href="/admin/work" className="underline underline-offset-4">
            See it in Work
          </Link>
          <button type="button" onClick={another} className="underline underline-offset-4">
            Add another
          </button>
        </span>
      </div>
    );
  }

  return (
    <form aria-labelledby="wk-new-h" onSubmit={submit} className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-w-0 space-y-5">
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-neutral-400">{suggestion ? "New task from Vizzy" : "New task"}</p>
          <h1 id="wk-new-h" className="text-xl font-semibold">
            Add a task
          </h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">{nextRefLine(screen.nextRef)}</p>
          {suggestion ? (
            <p className="flex items-start gap-1.5 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200">
              <Sparkles size={14} aria-hidden className="mt-0.5 shrink-0" />
              <span>
                <span className="font-medium">{WORK_COPY.fromSuggestion}</span> {suggestionFromLine(suggestion.from)}
              </span>
            </p>
          ) : null}
        </div>
        <div className="space-y-1">
          <div className="flex items-baseline justify-between">
            <label htmlFor="wk-f-title" className="text-sm font-medium">
              Title
            </label>
            <span className="text-xs tabular-nums text-neutral-400">
              {title.length} / {WORK_LIMITS.title}
            </span>
          </div>
          <input id="wk-f-title" type="text" required maxLength={WORK_LIMITS.title} placeholder="For example: Register for VAT" value={title} onChange={(e) => setTitle(e.target.value)} className={inputClass} />
          {titleWas ? <span className="block text-xs text-neutral-500">{vizzyWroteLine(titleWas)}</span> : null}
        </div>
        <div className="space-y-1">
          <label htmlFor="wk-f-desc" className="text-sm font-medium">
            Description <span className="font-normal text-neutral-500">(optional)</span>
          </label>
          <textarea id="wk-f-desc" rows={4} maxLength={WORK_LIMITS.description} value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} />
          <span className="block text-xs text-neutral-400">{repos.length > 0 ? WORK_COPY.descriptionCodeHint : WORK_COPY.descriptionHint}</span>
        </div>
        <div className="space-y-1">
          <p id="wk-f-status-l" className="text-sm font-medium">
            Status
          </p>
          <div role="radiogroup" aria-labelledby="wk-f-status-l" className="flex flex-wrap gap-1.5">
            {WORK_STATUSES.map((s) => (
              <button key={s} type="button" role="radio" aria-checked={status === s} onClick={() => setStatus(s)} className={RADIO(status === s, chipToneClass(WORK_STATUS_TONE[s]))}>
                {WORK_STATUS_LABEL[s]}
              </button>
            ))}
          </div>
        </div>
        <section aria-labelledby="wk-f-links-h" className="space-y-3">
          <h2 id="wk-f-links-h" className="text-sm font-semibold">
            Links <span className="font-normal text-neutral-500">(optional)</span>
          </h2>
          <div className="space-y-1">
            <div className="flex items-baseline justify-between">
              <p className="text-xs font-medium text-neutral-600 dark:text-neutral-400">Connected to</p>
              <span className="text-xs text-neutral-400">Up to 10</span>
            </div>
            <TypedLinksEditor
              links={typed}
              onChange={setTyped}
              repos={repos}
              ideas={options.ideas}
              operator={options.operator}
              loopsRepo={options.loopsRepo}
              ideaName={(b, i) => options.ideas.find((x) => x.value === `${b}:${i}`)?.label}
              ideaWords={screen.ideaWords}
            />
          </div>
          <div className="space-y-1">
            <div className="flex items-baseline justify-between">
              <p className="text-xs font-medium text-neutral-600 dark:text-neutral-400">Other links</p>
              <span className="text-xs text-neutral-400">Up to 20</span>
            </div>
            <FreeLinksEditor links={links} onChange={setLinks} hasRepo={repos.length > 0} />
          </div>
        </section>
        {error ? (
          <p role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
            {error}
          </p>
        ) : null}
        <div className="flex items-center gap-3">
          <Button type="submit" tone="primary" disabled={busy || !title.trim() || problems.length > 0 || checkInput === undefined}>
            {busy ? "Adding…" : "Add task"}
          </Button>
          <Link href={cancelHref} className="text-sm text-neutral-500 underline underline-offset-4">
            Cancel
          </Link>
        </div>
      </div>
      <aside aria-label="Details" className="space-y-5">
        <div className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <label className="block space-y-1">
            <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">Stage</span>
            <select id="wk-f-stage" value={stage ?? ""} onChange={(e) => setStage((e.target.value || null) as CompanyStage | null)} className={inputClass}>
              <option value="">No stage</option>
              {COMPANY_STAGES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.n} {s.label}
                </option>
              ))}
            </select>
          </label>
          {screen.multiBrand ? (
            <label className="block space-y-1">
              <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">Brand</span>
              <select id="wk-f-brand" value={brandId ?? "none"} onChange={(e) => setBrandId(e.target.value === "none" ? null : e.target.value)} className={inputClass}>
                {options.brands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
                {options.wholeBusiness ? <option value="none">Whole business</option> : null}
              </select>
              <span className="block text-xs text-neutral-500">{brand ? brandHint(brand.name) : WORK_COPY.wholeBusinessHint}</span>
            </label>
          ) : null}
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={mustHave} onChange={(e) => setMustHave(e.target.checked)} className="mt-1" />
            <span>
              <span className="block font-medium">Must have</span>
              <span className="block text-xs text-neutral-500">{WORK_COPY.mustHaveHint}</span>
            </span>
          </label>
          <div className="space-y-1">
            <label htmlFor="wk-f-block" className="text-xs font-medium text-neutral-600 dark:text-neutral-400">
              Blocked by <span className="font-normal">(optional)</span>
            </label>
            <BlockedByPicker id="wk-f-block" refs={blockedBy} onChange={setBlockedBy} openTasks={options.openTasks} />
          </div>
          <div className="space-y-1">
            <p id="wk-f-check-l" className="text-xs font-medium text-neutral-600 dark:text-neutral-400">
              Check <span className="font-normal">(optional)</span>
            </p>
            <CheckPicker id="wk-f-check" value={check} onChange={setCheck} today={zoneBrand?.today ?? ""} timeZone={zoneBrand?.timeZone ?? "UTC"} brandName={zoneBrand?.name ?? screen.sessionBrand.name} openTasks={options.openTasks} />
          </div>
        </div>
        <section aria-labelledby="wk-f-ms-h" className="space-y-2 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 id="wk-f-ms-h" className="text-sm font-semibold">
            {WORK_COPY.measureTitle} <span className="font-normal text-neutral-500">(optional)</span>
          </h2>
          <MeasurePicker
            idPrefix="wk-f-ms"
            value={measure}
            onChange={setMeasure}
            suggestion={proposed}
            suggestedBy={suggestion?.proposed ? "vizzy" : "rule"}
            products={brand ? brand.products : null}
            meanings={options.meanings}
            operator={options.operator}
            runsInApp={repos.length > 0 || (brand?.products.length ?? 0) > 0}
            word={brand?.word ?? null}
          />
        </section>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">{WORK_COPY.formFoot}</p>
      </aside>
    </form>
  );
}

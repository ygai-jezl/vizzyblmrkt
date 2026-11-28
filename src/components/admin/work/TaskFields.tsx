"use client";

import { useEffect, useState } from "react";
import { FileText, GitPullRequest, Lightbulb, Link2, Repeat, ToggleRight, X } from "lucide-react";
import { Button, inputClass } from "@/components/admin/connect/ui";
import { Chip } from "@/components/admin/people/Chip";
import { LOOPS } from "@/lib/loops/registry";
import {
  blankTypedLink,
  dayOfPick,
  freeLinkOf,
  freeLinkWords,
  sameTypedLink,
  switchNameOf,
  typedLinkOf,
  typedLinkWords,
  type CheckDraft,
  type CheckPick,
  type TypedLinkDraft,
  type TypedLinkKind,
} from "@/lib/work/form";
import { ideaWord } from "@/lib/nav/terms";
import { railLabel, typedHintText, WORK_COPY, WORK_STATUS_TONE, zoneHint } from "@/lib/work/screenWords";
import { WORK_LIMITS, type TypedLink, type WorkLink } from "@/lib/work/types";
import { WORK_STATUS_LABEL } from "@/lib/work/words";
import type { OpenTaskOption } from "@/lib/work/screens";
import { useInRow } from "./rowEditors";

/**
 * The pieces the add page and the task page share: Connected to (typed links), Other links, the
 * tasks it waits for, and its check. Each holds plain data; the routes check it all again.
 */

/**
 * Enter in one of these editors' own boxes runs that editor's add (or picks the first task found),
 * never the add page's Add task: the form would otherwise submit the task and drop what was typed.
 */
export function onEnter(go: () => void) {
  return (e: { key: string; preventDefault: () => void; nativeEvent?: { isComposing?: boolean } }) => {
    if (e.key !== "Enter" || e.nativeEvent?.isComposing) return;
    e.preventDefault();
    go();
  };
}

/** Each kind's label, button and hint; an idea in this copy's word for one. */
export function kindWords(ideaWords: boolean): Record<TypedLinkKind, { label: string; add: string; hint: string }> {
  const w = ideaWord(ideaWords);
  return {
    pull_request: { label: "Pull request", add: "Add pull request", hint: "A repo your brand selected, and the pull request's number." },
    switch: { label: "Switch", add: "Add switch", hint: "The switch's name as the code reads it: capitals, digits and underscores. Or none, and why." },
    idea: { label: w.One, add: `Add ${w.one}`, hint: `Another ${w.one} this task touches.` },
    plan: { label: "Plan", add: "Add plan", hint: "A plan page for this task: its title and an https link. Approve it on the task." },
    loop_line: { label: "Loop line", add: "Add loop line", hint: "The line in this copy's own loops registry the change touches, or none, and why." },
  };
}

function LinkIcon({ kind }: { kind: TypedLinkKind | "free" }) {
  const Icon = kind === "pull_request" ? GitPullRequest : kind === "switch" ? ToggleRight : kind === "idea" ? Lightbulb : kind === "plan" ? FileText : kind === "loop_line" ? Repeat : Link2;
  return <Icon size={14} aria-hidden className="shrink-0 text-neutral-500" />;
}

export interface TypedLinksProps {
  links: TypedLink[];
  onChange: (links: TypedLink[]) => void;
  repos: Array<{ provider: "github" | "gitlab"; fullPath: string }>;
  ideas: Array<{ value: string; label: string }>;
  operator: boolean;
  loopsRepo: string | null;
  ideaName: (brandId: string, ideaId: string) => string | undefined;
  /** This copy calls a launch an idea (isIdeaWordsEnabled(), from the screen). */
  ideaWords: boolean;
  /** Told whether a link is half typed here, so the open row on Work's list can ask before it goes. */
  onDirty?: (dirty: boolean) => void;
}

/** Calls `onDirty` when whether something is half typed changes. */
function useDirty(dirty: boolean, onDirty?: (dirty: boolean) => void) {
  useEffect(() => {
    onDirty?.(dirty);
  }, [dirty, onDirty]);
}

/** The kinds a task can connect: a pull request and a switch only with a connected repo; a loop line for operators beside this copy's own repo. */
export function typedKinds(o: { repos: TypedLinksProps["repos"]; operator: boolean; loopsRepo: string | null; links: readonly TypedLink[] }): TypedLinkKind[] {
  const own = o.loopsRepo?.toLowerCase() ?? null;
  const loop = o.operator && own !== null && o.links.some((l) => l.kind === "pull_request" && l.repo.toLowerCase() === own);
  return [...(o.repos.length ? (["pull_request", "switch"] as const) : []), "idea", "plan", ...(loop ? (["loop_line"] as const) : [])];
}

/** Connected to: the exact links agents can follow, with one to add. */
export function TypedLinksEditor({ links, onChange, repos, ideas, operator, loopsRepo, ideaName, ideaWords, onDirty }: TypedLinksProps) {
  const kinds = typedKinds({ repos, operator, loopsRepo, links });
  const KIND_WORDS = kindWords(ideaWords);
  const word = ideaWord(ideaWords);
  const firstRepo = repos[0] ? `${repos[0].provider}:${repos[0].fullPath}` : "";
  const [draft, setDraft] = useState<TypedLinkDraft>(blankTypedLink(kinds[0]!, firstRepo));
  const [problem, setProblem] = useState<string | null>(null);
  const kind = kinds.includes(draft.kind) ? draft.kind : kinds[0]!;
  const d = { ...draft, kind };
  useDirty(!!(d.number || d.switchName || d.noneReason.trim() || d.planTitle.trim() || d.planUrl || d.planVersion.trim() || d.idea || d.loopKind), onDirty);
  const set = (patch: Partial<TypedLinkDraft>) => {
    setProblem(null);
    setDraft({ ...d, ...patch });
  };
  const add = () => {
    const r = typedLinkOf(d, ideaWords);
    if (!r.ok) return setProblem(r.problem);
    if (links.some((l) => sameTypedLink(l, r.link))) return setProblem("That link is on the task already.");
    if (links.length >= WORK_LIMITS.typedLinks) return setProblem("A task keeps up to 10 links under Connected to.");
    onChange([...links, r.link]);
    setDraft(blankTypedLink(kind, d.repo));
  };
  const freeIdeas = ideas.filter((i) => !links.some((l) => l.kind === "idea" && `${l.brandId}:${l.ideaId}` === i.value));
  return (
    <div className="space-y-2">
      <p className="text-xs text-neutral-500 dark:text-neutral-400">{typedHintText(repos.length > 0, ideaWords)}</p>
      {links.length ? (
        <ul className="space-y-1">
          {links.map((l, i) => {
            const w = typedLinkWords(l, { ideaName, ideaWords });
            return (
              <li key={`${l.kind}${i}`} className="flex items-center gap-2 rounded-md border border-neutral-200 px-2 py-1.5 dark:border-neutral-800">
                <LinkIcon kind={l.kind} />
                <span className="min-w-0 flex-1">
                  <span className={`block truncate ${l.kind === "switch" || l.kind === "loop_line" ? "font-mono text-xs" : "font-medium"}`}>{w.label}</span>
                  <span className="block text-xs text-neutral-500">{w.where}</span>
                </span>
                <button type="button" aria-label={`Remove ${w.label}`} onClick={() => onChange(links.filter((_, j) => j !== i))} className="rounded p-1 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-900">
                  <X size={14} aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <div role="group" aria-label="Connect" className="space-y-2">
        <div role="radiogroup" aria-label="What to connect" className="flex flex-wrap gap-1">
          {kinds.map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              onClick={() => set({ kind: k })}
              className={`rounded-md border px-2 py-1 text-xs ${kind === k ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900" : "border-neutral-300 dark:border-neutral-700"}`}
            >
              {KIND_WORDS[k].label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {kind === "pull_request" ? (
            <>
              <select aria-label="Repo" value={d.repo} onChange={(e) => set({ repo: e.target.value })} className={`${inputClass} w-auto`}>
                {repos.map((r) => (
                  <option key={`${r.provider}:${r.fullPath}`} value={`${r.provider}:${r.fullPath}`}>
                    {r.fullPath}
                  </option>
                ))}
              </select>
              <input
                type="text"
                inputMode="numeric"
                aria-label="Pull request number"
                placeholder="Number, like 84"
                value={d.number}
                onChange={(e) => set({ number: e.target.value.replace(/[^0-9]/g, "").slice(0, 9) })}
                onKeyDown={onEnter(add)}
                className={`${inputClass} w-36`}
              />
            </>
          ) : null}
          {kind === "switch" || kind === "loop_line" ? (
            <label className="flex items-center gap-1.5 text-xs">
              <input type="checkbox" checked={d.none} onChange={(e) => set({ none: e.target.checked })} />
              {kind === "switch" ? "No switch" : "No loop line"}
            </label>
          ) : null}
          {(kind === "switch" || kind === "loop_line") && d.none ? (
            <input type="text" aria-label="Why there is none" placeholder="Why there is none" maxLength={140} value={d.noneReason} onChange={(e) => set({ noneReason: e.target.value })} onKeyDown={onEnter(add)} className={`${inputClass} min-w-[12rem] flex-1`} />
          ) : null}
          {kind === "switch" && !d.none ? (
            <input
              type="text"
              aria-label="Switch name"
              placeholder="SHARED_NOTEBOOKS_ENABLED"
              value={d.switchName}
              onChange={(e) => set({ switchName: switchNameOf(e.target.value) })}
              onKeyDown={onEnter(add)}
              className={`${inputClass} min-w-[14rem] flex-1 font-mono`}
            />
          ) : null}
          {kind === "loop_line" && !d.none ? (
            <select aria-label="Loop line" value={d.loopKind} onChange={(e) => set({ loopKind: e.target.value })} className={`${inputClass} w-auto`}>
              <option value="">Pick a loop line</option>
              {Object.keys(LOOPS).map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          ) : null}
          {kind === "idea" ? (
            <select aria-label={word.One} value={d.idea} onChange={(e) => set({ idea: e.target.value })} className={`${inputClass} w-auto`}>
              <option value="">{freeIdeas.length ? `Pick ${word.a}` : `No other ${word.many}`}</option>
              {freeIdeas.map((i) => (
                <option key={i.value} value={i.value}>
                  {i.label}
                </option>
              ))}
            </select>
          ) : null}
          {kind === "plan" ? (
            <>
              <input type="text" aria-label="Plan title" placeholder="Plan title" maxLength={120} value={d.planTitle} onChange={(e) => set({ planTitle: e.target.value })} onKeyDown={onEnter(add)} className={`${inputClass} min-w-[10rem] flex-1`} />
              <input type="url" aria-label="Plan link" placeholder="https://" maxLength={2000} value={d.planUrl} onChange={(e) => set({ planUrl: e.target.value.trim() })} onKeyDown={onEnter(add)} className={`${inputClass} min-w-[12rem] flex-1`} />
              <input type="text" aria-label="Version (optional)" placeholder="Version (optional)" maxLength={40} value={d.planVersion} onChange={(e) => set({ planVersion: e.target.value })} onKeyDown={onEnter(add)} className={`${inputClass} w-36`} />
            </>
          ) : null}
          <Button onClick={add}>{KIND_WORDS[kind].add}</Button>
        </div>
        {problem ? (
          <p role="alert" className="text-xs text-red-700 dark:text-red-400">
            {problem}
          </p>
        ) : (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{KIND_WORDS[kind].hint}</p>
        )}
      </div>
    </div>
  );
}

/** Other links: an AI chat, a page, a doc. */
export function FreeLinksEditor({ links, onChange, hasRepo, onDirty }: { links: WorkLink[]; onChange: (links: WorkLink[]) => void; hasRepo: boolean; onDirty?: (dirty: boolean) => void }) {
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  useDirty(!!(url.trim() || label.trim()), onDirty);
  const add = () => {
    if (!url.trim()) return;
    const r = freeLinkOf(url, label);
    if (!r.ok) return setProblem(r.problem);
    if (links.length >= WORK_LIMITS.links) return setProblem("A task keeps up to 20 other links.");
    onChange([...links, r.link]);
    setUrl("");
    setLabel("");
    setProblem(null);
  };
  return (
    <div className="space-y-2">
      {links.length ? (
        <ul className="space-y-1">
          {links.map((l, i) => {
            const w = freeLinkWords(l);
            return (
              <li key={`${l.url}${i}`} className="flex items-center gap-2 rounded-md border border-neutral-200 px-2 py-1.5 dark:border-neutral-800">
                <LinkIcon kind="free" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{w.label}</span>
                  <span className="block text-xs text-neutral-500">{w.where}</span>
                </span>
                <button type="button" aria-label={`Remove ${w.label}`} onClick={() => onChange(links.filter((_, j) => j !== i))} className="rounded p-1 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-900">
                  <X size={14} aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <input type="url" aria-label="Paste a link" placeholder="Paste a link: an AI chat, a page or a doc" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={onEnter(add)} className={`${inputClass} min-w-[14rem] flex-1`} />
        <input type="text" aria-label="What it is (optional)" placeholder="What it is (optional)" maxLength={120} value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={onEnter(add)} className={`${inputClass} w-48`} />
        <Button disabled={!url.trim()} onClick={add}>
          Add link
        </Button>
      </div>
      {problem ? (
        <p role="alert" className="text-xs text-red-700 dark:text-red-400">
          {problem}
        </p>
      ) : (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">{hasRepo ? WORK_COPY.linkHintRepo : WORK_COPY.linkHintNoRepo}</p>
      )}
    </div>
  );
}

/** The tasks it waits for: up to 5, found by ref or title among the open ones. */
export function BlockedByPicker({ refs, onChange, openTasks, id }: { refs: number[]; onChange: (refs: number[]) => void; openTasks: OpenTaskOption[]; id: string }) {
  const [query, setQuery] = useState("");
  // In the open row on Work's list, Esc closes the list of tasks found first, then the editor.
  const inRow = useInRow();
  const q = query.trim().toLowerCase().replace(/^#/, "");
  const results = q ? openTasks.filter((t) => !refs.includes(t.ref) && (String(t.ref).startsWith(q) || t.title.toLowerCase().includes(q))).slice(0, 5) : [];
  const byRef = (ref: number) => openTasks.find((t) => t.ref === ref);
  const pick = (ref: number) => {
    onChange([...refs, ref]);
    setQuery("");
  };
  return (
    <div className="space-y-1.5">
      {refs.length ? (
        <div className="flex flex-wrap gap-1">
          {refs.map((r) => (
            <span key={r} className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-xs dark:bg-neutral-800">
              #{r} {byRef(r)?.title ?? ""}
              <button type="button" aria-label={`Remove #${r}`} onClick={() => onChange(refs.filter((x) => x !== r))}>
                <X size={12} aria-hidden />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {refs.length < WORK_LIMITS.blockedBy ? (
        <div className="relative">
          <input
            id={id}
            type="text"
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls={`${id}-list`}
            placeholder="Find a task by ref or title"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (inRow && e.key === "Escape" && query) {
                e.preventDefault();
                e.stopPropagation();
                setQuery("");
                return;
              }
              onEnter(() => {
                if (results[0]) pick(results[0].ref);
              })(e);
            }}
            className={inputClass}
          />
          {results.length ? (
            <ul id={`${id}-list`} role="listbox" aria-label="Tasks" className="mt-1 divide-y divide-neutral-100 rounded-md border border-neutral-200 dark:divide-neutral-900 dark:border-neutral-800">
              {results.map((t) => (
                <li key={t.ref} role="option" aria-selected={false}>
                  <button
                    type="button"
                    onClick={() => pick(t.ref)}
                    className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-neutral-50 dark:hover:bg-neutral-900"
                  >
                    <span className="tabular-nums text-neutral-500">#{t.ref}</span>
                    <span className="min-w-0 flex-1 truncate">{t.title}</span>
                    <Chip tone={WORK_STATUS_TONE[t.status]}>{WORK_STATUS_LABEL[t.status]}</Chip>
                  </button>
                </li>
              ))}
            </ul>
          ) : q ? (
            <p className="mt-1 text-xs text-neutral-500">{WORK_COPY.noOpenTask}</p>
          ) : null}
        </div>
      ) : null}
      <span className="block text-xs text-neutral-500 dark:text-neutral-400">{WORK_COPY.blockedByHint}</span>
    </div>
  );
}

const PICKS: Array<{ pick: CheckPick; label: string }> = [
  { pick: "tomorrow", label: "Tomorrow morning" },
  { pick: "week", label: "Next week" },
  { pick: "two", label: "In 2 weeks" },
  { pick: "pick", label: "Pick a date" },
];

/** The check: none, on a date (08:00 brand time unless changed), or when another task is done. */
export function CheckPicker({ value, onChange, today, timeZone, brandName, openTasks, id }: { value: CheckDraft; onChange: (d: CheckDraft) => void; today: string; timeZone: string; brandName: string; openTasks: OpenTaskOption[]; id: string }) {
  const d = value;
  const set = (patch: Partial<CheckDraft>) => onChange({ ...d, ...patch });
  return (
    <div className="space-y-2">
      <div role="radiogroup" aria-labelledby={`${id}-l`} className="flex flex-wrap gap-3 text-sm">
        {(
          [
            ["none", "No check"],
            ["date", "On a date"],
            ["after_task", "When another task is done"],
          ] as const
        ).map(([k, l]) => (
          <label key={k} className="flex items-center gap-1.5">
            <input type="radio" name={`${id}-kind`} checked={d.kind === k} onChange={() => set({ kind: k })} /> {l}
          </label>
        ))}
      </div>
      {d.kind === "date" ? (
        <div className="space-y-2">
          <div role="group" aria-label="When" className="grid grid-cols-2 gap-1.5">
            {PICKS.map((p) => (
              <button
                key={p.pick}
                type="button"
                aria-pressed={d.pick === p.pick}
                onClick={() => set({ pick: p.pick, day: p.pick === "pick" && !d.day ? dayOfPick("tomorrow", today, "") : d.day })}
                className={`flex flex-col items-start rounded-md border px-2 py-1.5 text-left text-xs ${d.pick === p.pick ? "border-sky-400 bg-sky-50 dark:border-sky-700 dark:bg-sky-950/40" : "border-neutral-200 dark:border-neutral-800"}`}
              >
                <span className="font-medium">{p.label}</span>
                <span className="text-neutral-500">{p.pick === "pick" ? (d.pick === "pick" && d.day ? railLabel(d.day) : "Any day") : railLabel(dayOfPick(p.pick, today, ""))}</span>
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {d.pick === "pick" ? <input type="date" aria-label="Date" min={today} value={d.day} onChange={(e) => set({ day: e.target.value })} className={`${inputClass} w-auto`} /> : null}
            <label className="flex items-center gap-1.5">
              at <input type="time" aria-label="Time" value={d.time} onChange={(e) => set({ time: e.target.value || "08:00" })} className={`${inputClass} w-auto`} />
            </label>
          </div>
          <span className="block text-xs text-neutral-500 dark:text-neutral-400">{zoneHint(brandName, timeZone)}</span>
        </div>
      ) : null}
      {d.kind === "after_task" ? (
        <div className="space-y-1">
          <select aria-label="When this task is done" value={d.afterRef ?? ""} onChange={(e) => set({ afterRef: e.target.value ? Number(e.target.value) : null })} className={inputClass}>
            <option value="">Pick a task</option>
            {openTasks.map((t) => (
              <option key={t.ref} value={t.ref}>
                #{t.ref} {t.title}
              </option>
            ))}
          </select>
          <span className="block text-xs text-neutral-500 dark:text-neutral-400">{WORK_COPY.afterTaskHint}</span>
        </div>
      ) : null}
      {d.kind !== "none" ? <input type="text" aria-label="What to look at" placeholder="What to look at (optional)" maxLength={280} value={d.note} onChange={(e) => set({ note: e.target.value })} className={inputClass} /> : null}
    </div>
  );
}

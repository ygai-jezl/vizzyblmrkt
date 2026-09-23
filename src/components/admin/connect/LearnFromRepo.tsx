"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { BookOpenCheck, ChevronDown, ChevronRight, GitBranch, Plus, ShieldCheck, Trash2 } from "lucide-react";
import type { ProductMap } from "@/lib/connect/productMapSchema";
import type { RepoAnalysis } from "@/lib/types/repoAnalysis";
import { api, errorText, timeAgo, type PublicConnection } from "./api";
import { Badge, Banner, Button, Field, Section, inputClass } from "./ui";
import { GitHubRepoChooser } from "./GitHubRepoChooser";

/**
 * "Learn from your repo": we read the product's code (read-only — clone, read,
 * discard) and propose its catalog: onboarding steps and how each completes,
 * events, traits, facts and glossary, each with the code it came from. A person
 * ticks what's right and adds it to the catalog.
 */

type SectionId = "steps" | "events" | "traits" | "facts" | "glossary";
type Evidence = ProductMap["events"][number]["evidence"][number];
type Item = { key: string; title: string; detail: string; badges: string[]; confidence: string; evidence: Evidence[] };

const RUNNING = new Set(["queued", "running"]);

function itemsOf(map: ProductMap): Record<SectionId, Item[]> {
  return {
    steps: map.onboardingSteps.map((s) => ({
      key: s.id,
      title: `${s.label} (${s.id})`,
      detail: [s.completion, s.path ? `Route: ${s.path}` : ""].filter(Boolean).join(" · "),
      badges: [s.detection === "server_event" ? "server event" : s.detection === "reconcile" ? "from stored state" : "browser only"],
      confidence: s.confidence,
      evidence: s.evidence,
    })),
    events: map.events.map((e) => ({ key: e.name, title: e.name, detail: [e.description, e.when].filter(Boolean).join(" — "), badges: [], confidence: e.confidence, evidence: e.evidence })),
    traits: map.traits.map((t) => ({ key: t.key, title: `${t.label || t.key} (${t.key})`, detail: t.description, badges: [t.type], confidence: t.confidence, evidence: t.evidence })),
    facts: map.facts.map((f) => ({
      key: f.id,
      title: `${f.label} (${f.id})`,
      detail: [f.description, f.source ? `Source: ${f.source}` : ""].filter(Boolean).join(" · "),
      badges: [f.unit ? `${f.type}, ${f.unit}` : f.type],
      confidence: f.confidence,
      evidence: f.evidence,
    })),
    glossary: map.glossary.map((g) => ({ key: g.term, title: g.term, detail: g.definition, badges: [], confidence: g.confidence, evidence: g.evidence })),
  };
}

/** Ticked by default: backed by verified code evidence and not low confidence. */
const trusted = (i: Item) => i.confidence !== "low" && i.evidence.some((e) => e.verified);

const SECTIONS: Array<{ id: SectionId; title: string; description: string }> = [
  { id: "steps", title: "Onboarding steps", description: "What getting started means in your product, and how each step counts as done." },
  { id: "events", title: "Events", description: "Actions your product can report to us." },
  { id: "traits", title: "Traits", description: "Attributes journeys can branch on." },
  { id: "facts", title: "Facts", description: "Numbers your context endpoint can return about each user — for insights and branching." },
  { id: "glossary", title: "Glossary", description: "Your product's terms, for the writing." },
];

export function LearnFromRepo({ connection, canEdit, onAccepted }: { connection: PublicConnection; canEdit: boolean; onAccepted: () => void }) {
  const [analyses, setAnalyses] = useState<RepoAnalysis[] | null>(null);
  /** Repos ticked from the read-only GitHub app's list. */
  const [picked, setPicked] = useState<string[]>([]);
  /** Other repositories by address (GitLab, or a public repo). */
  const [repos, setRepos] = useState<Array<{ url: string; ref: string }>>([]);
  const [selected, setSelected] = useState<Record<SectionId, Set<string>>>({ steps: new Set(), events: new Set(), traits: new Set(), facts: new Set(), glossary: new Set() });
  const [open, setOpen] = useState<string | null>(null);
  const [origin, setOrigin] = useState(connection.linkDomains[0] ? `https://${connection.linkDomains[0]}` : "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err" | "info"; text: string } | null>(null);

  const latest = analyses?.[0] ?? null;
  const map = latest?.map ?? null;
  const items = useMemo(() => (map ? itemsOf(map) : null), [map]);

  const load = useCallback(async () => {
    const r = await api<{ analyses: RepoAnalysis[] }>(`/api/admin/connections/${connection.id}/learn`);
    if (!r.ok) return setMsg({ tone: "err", text: errorText(r.data) });
    setAnalyses(r.data.analyses);
  }, [connection.id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll while a run is in progress.
  useEffect(() => {
    if (!latest || !RUNNING.has(latest.status)) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [latest, load]);

  // Pre-tick the trustworthy items whenever a new map arrives.
  useEffect(() => {
    if (!items) return;
    const pick = (s: SectionId) => new Set(items[s].filter(trusted).map((i) => i.key));
    setSelected({ steps: pick("steps"), events: pick("events"), traits: pick("traits"), facts: pick("facts"), glossary: pick("glossary") });
  }, [items]);

  const start = async () => {
    setBusy(true);
    setMsg(null);
    const body = {
      repos: [
        ...picked.map((url) => ({ url, ref: null })),
        ...repos.filter((r) => r.url.trim()).map((r) => ({ url: r.url.trim(), ref: r.ref.trim() || null })),
      ].slice(0, 3),
    };
    const r = await api(`/api/admin/connections/${connection.id}/learn`, { method: "POST", body: JSON.stringify(body) });
    setBusy(false);
    if (!r.ok) return setMsg({ tone: "err", text: errorText(r.data) });
    await load();
  };

  const accept = async () => {
    if (!latest) return;
    setBusy(true);
    setMsg(null);
    const body = {
      steps: [...selected.steps],
      events: [...selected.events],
      traits: [...selected.traits],
      facts: [...selected.facts],
      glossary: [...selected.glossary],
      appOrigin: origin.trim() || null,
    };
    const r = await api<{ accepted: Record<SectionId, number> }>(`/api/admin/connections/${connection.id}/learn/${latest.id}/accept`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!r.ok) return setMsg({ tone: "err", text: errorText(r.data) });
    const n = Object.values(r.data.accepted).reduce((a, b) => a + b, 0);
    setMsg({ tone: "ok", text: `Added ${n} item${n === 1 ? "" : "s"} to the catalog.` });
    await load();
    onAccepted();
  };

  const toggle = (s: SectionId, key: string) =>
    setSelected((cur) => {
      const next = new Set(cur[s]);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { ...cur, [s]: next };
    });

  const blobUrl = (ev: Evidence): string | null => {
    if (!latest) return null;
    const multi = latest.repos.length > 1;
    const repo = multi ? latest.repos.find((r) => ev.path.startsWith(`${r.label}/`)) : latest.repos[0];
    if (!repo) return null;
    const path = multi ? ev.path.slice(repo.label.length + 1) : ev.path;
    const sep = repo.provider === "gitlab" ? "/-/blob/" : "/blob/";
    return `${repo.url}${sep}${repo.ref || "HEAD"}/${path}${ev.line ? `#L${ev.line}` : ""}`;
  };

  const anySelected = Object.values(selected).some((s) => s.size > 0);

  return (
    <div className="space-y-4">
      {msg ? <Banner tone={msg.tone}>{msg.text}</Banner> : null}

      <Section
        title="Learn from your repo"
        description="We read your product's code and propose its catalog — the steps of getting started and how each is done, the events it can send, and the facts it can report — with the code each came from. You choose what to keep."
      >
        <p className="flex items-start gap-1.5 text-xs text-neutral-500">
          <ShieldCheck size={14} className="mt-px shrink-0" />
          Read-only: we clone, read and delete the copy — we never change your code, and we keep only short excerpts as evidence
          (secrets are removed). GitLab connects in{" "}
          <Link className="underline" href="/admin/account/connections">
            Account → Connections
          </Link>
          .
        </p>
        <GitHubRepoChooser selected={picked} onChange={setPicked} max={3 - repos.filter((r) => r.url.trim()).length} canEdit={canEdit} />
        {canEdit ? (
          <div className="space-y-2">
            {repos.map((r, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-[3fr_1fr_auto]">
                <input className={inputClass} value={r.url} placeholder="github.com/your-org/your-app" onChange={(e) => setRepos(repos.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} />
                <input className={inputClass} value={r.ref} placeholder="branch (default)" onChange={(e) => setRepos(repos.map((x, j) => (j === i ? { ...x, ref: e.target.value } : x)))} />
                <Button aria-label="Remove repo" onClick={() => setRepos(repos.filter((_, j) => j !== i))}>
                  <Trash2 size={14} />
                </Button>
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button disabled={picked.length + repos.length >= 3} onClick={() => setRepos([...repos, { url: "", ref: "" }])}>
                <Plus size={14} /> {repos.length ? "Another address" : "Add a repository by address (GitLab or public)"}
              </Button>
              <Button
                tone="primary"
                disabled={busy || (picked.length === 0 && !repos.some((r) => r.url.trim())) || (latest !== null && RUNNING.has(latest.status))}
                onClick={() => void start()}
              >
                <GitBranch size={14} /> {latest && RUNNING.has(latest.status) ? "Reading your code…" : "Learn from repo"}
              </Button>
            </div>
          </div>
        ) : null}
      </Section>

      {latest ? (
        <div className="space-y-1 text-sm">
          {RUNNING.has(latest.status) ? (
            <Banner tone="info">Reading your code — this usually takes a few minutes. You can leave this page.</Banner>
          ) : latest.status === "failed" ? (
            <Banner tone="err">The analysis failed: {errorText({ error: latest.error ?? "error" })}</Banner>
          ) : latest.status === "incomplete" ? (
            <Banner tone="info">The analysis ran out of budget before finishing — here&apos;s what it found.</Banner>
          ) : null}
          <p className="text-xs text-neutral-500">
            {latest.repos.map((r) => r.url.replace("https://", "") + (r.ref ? `@${r.ref}` : "")).join(", ")} · started {timeAgo(latest.createdAt)}
            {latest.stats ? ` · ${latest.stats.files} files read · ${latest.stats.verifiedItems}/${latest.stats.items} items backed by code` : ""}
            {latest.acceptedAt ? ` · added to the catalog ${timeAgo(latest.acceptedAt)}` : ""}
          </p>
        </div>
      ) : null}

      {map && items ? (
        <>
          {map.summary ? <p className="rounded-md bg-neutral-50 p-3 text-sm dark:bg-neutral-900">{map.summary}</p> : null}
          {map.warnings.length > 0 ? (
            <Banner tone="info">
              <span className="font-medium">Worth knowing:</span> {map.warnings.join(" · ")}
            </Banner>
          ) : null}

          {SECTIONS.filter((s) => items[s.id].length > 0).map((s) => (
            <Section key={s.id} title={s.title} description={s.description}>
              <ul className="divide-y divide-neutral-100 dark:divide-neutral-900">
                {items[s.id].map((it) => {
                  const id = `${s.id}:${it.key}`;
                  const verified = it.evidence.filter((e) => e.verified).length;
                  return (
                    <li key={id} className="py-2">
                      <div className="flex items-start gap-2">
                        <input type="checkbox" className="mt-1" disabled={!canEdit} checked={selected[s.id].has(it.key)} onChange={() => toggle(s.id, it.key)} aria-label={`Keep ${it.title}`} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                            {it.title}
                            {it.badges.map((b) => (
                              <Badge key={b}>{b}</Badge>
                            ))}
                            <Badge tone={it.confidence === "high" ? "green" : it.confidence === "low" ? "red" : "amber"}>{it.confidence}</Badge>
                            {verified === 0 ? <Badge tone="red">no verified code</Badge> : null}
                          </div>
                          {it.detail ? <p className="text-sm text-neutral-600 dark:text-neutral-400">{it.detail}</p> : null}
                          {it.evidence.length > 0 ? (
                            <button type="button" className="mt-1 inline-flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-800" onClick={() => setOpen(open === id ? null : id)}>
                              {open === id ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Evidence ({verified}/{it.evidence.length} verified)
                            </button>
                          ) : null}
                          {open === id ? (
                            <ul className="mt-1 space-y-1">
                              {it.evidence.map((ev, k) => {
                                const href = blobUrl(ev);
                                return (
                                  <li key={k} className="rounded border border-neutral-200 p-2 text-xs dark:border-neutral-800">
                                    <div className="flex items-center gap-1.5 font-mono">
                                      {href ? (
                                        <a className="underline" href={href} target="_blank" rel="noreferrer noopener">
                                          {ev.path}
                                          {ev.line ? `:${ev.line}` : ""}
                                        </a>
                                      ) : (
                                        <span>{ev.path}</span>
                                      )}
                                      {ev.verified ? <Badge tone="green">found in file</Badge> : <Badge tone="red">not found</Badge>}
                                    </div>
                                    <pre className="mt-1 whitespace-pre-wrap text-neutral-600 dark:text-neutral-400">{ev.excerpt}</pre>
                                  </li>
                                );
                              })}
                            </ul>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Section>
          ))}

          {map.hooks.length > 0 ? (
            <Section title="For your developers" description="What your side of the integration needs to handle. These go into your integration guide, not the catalog.">
              <ul className="space-y-1 text-sm">
                {map.hooks.map((h, i) => (
                  <li key={i}>
                    <Badge>{h.kind.replace("_", " ")}</Badge> {h.description}
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {canEdit ? (
            <Section title="Add to the catalog" description="Existing catalog entries with the same id are replaced; everything else is added.">
              <Field label="Your app's web address" hint="Turns the step routes above into links in emails. It's added to the connection's allowed link domains.">
                <input className={inputClass} value={origin} placeholder="https://app.example.com" onChange={(e) => setOrigin(e.target.value)} />
              </Field>
              <Button tone="primary" disabled={busy || !anySelected} onClick={() => void accept()}>
                <BookOpenCheck size={14} /> Add selected to the catalog
              </Button>
            </Section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { BRAND_MAP_LIMITS, type BrandMap, type BrandMapDecided, type BrandMapLink, type BrandMapSuggestion } from "@/lib/types/brandMap";
import { normalizeUrl } from "@/lib/content/blog/brief";
import { applyChanges } from "@/lib/brandMap/changes";
import { api, errorText } from "@/components/admin/connect/api";
import { Banner, Button } from "@/components/admin/connect/ui";
import { BrandMapIdentity } from "./BrandMapIdentity";
import { BrandMapLookup } from "./BrandMapLookup";
import { BrandMapMarkup } from "./BrandMapMarkup";
import { BrandMapNames } from "./BrandMapNames";
import { BrandMapSubjects } from "./BrandMapSubjects";
import { BrandMapSuggestions } from "./BrandMapSuggestions";
import { decidedOf, firstRunFill, isBlank, isDirty, type BrandMapPageProps, type MapIssue } from "./brandMapForm";

/**
 * Brand › Brand map. The decided half lives in the form until Save; suggestions come from
 * the server (never copied into state, so a refresh — after Vizzy files one — keeps the
 * person's edits). Accepting a suggestion puts its change into the form; dismissing is at
 * once. A save names the revision it started from: if someone else saved first, the page
 * says so and offers their version or a save over it.
 */

const MAP_ROUTE = "/api/admin/brand-kit/map";

export function BrandMapEditor(props: BrandMapPageProps) {
  const router = useRouter();
  const [form, setForm] = useState<BrandMapDecided>(props.initial);
  const [saved, setSaved] = useState<BrandMapDecided>(props.initial);
  const [baseRev, setBaseRev] = useState(props.rev);
  const [accepted, setAccepted] = useState<string[]>([]);
  const [gone, setGone] = useState<string[]>([]);
  const [issues, setIssues] = useState<MapIssue[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "err" | "info"; text: string } | null>(null);
  const [conflict, setConflict] = useState<BrandMap | null>(null);
  const [started, setStarted] = useState(!isBlank(props.initial) || props.rev > 0);
  const [freshSuggestions, setFreshSuggestions] = useState<BrandMapSuggestion[] | null>(null);
  const dirty = isDirty(form, saved) || accepted.length > 0;
  const editable = props.canEdit && !props.unreadable;

  // Whatever the server says is waiting, less what this person has just accepted or dismissed.
  const suggestions = useMemo(() => {
    const done = new Set([...accepted, ...gone]);
    return (freshSuggestions ?? props.suggestions).filter((s) => !done.has(s.key));
  }, [freshSuggestions, props.suggestions, accepted, gone]);
  useEffect(() => setFreshSuggestions(null), [props.suggestions]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const accept = (rows: BrandMapSuggestion[]) => {
    const { decided, issues: problems } = applyChanges(form, rows.map((r) => r.change));
    setForm(decided);
    setAccepted((prev) => [...new Set([...prev, ...rows.map((r) => r.key)])]);
    setNote(
      problems.length
        ? { tone: "err", text: `Some could not be added: ${problems.join("; ")}.` }
        : { tone: "info", text: "Added. Save to keep it." },
    );
  };

  const dismiss = async (rows: BrandMapSuggestion[]) => {
    if (!rows.length) return;
    setBusy(true);
    const res = await api<{ map?: BrandMap; error?: string }>(`${MAP_ROUTE}/suggestions`, {
      method: "DELETE",
      body: JSON.stringify({ keys: rows.map((r) => r.key) }),
    });
    setBusy(false);
    if (!res.ok) return setNote({ tone: "err", text: errorText(res.data) });
    setGone((prev) => [...new Set([...prev, ...rows.map((r) => r.key)])]);
    router.refresh();
  };

  const save = async (rev = baseRev) => {
    setBusy(true);
    setIssues([]);
    setNote(null);
    const res = await api<{ map?: BrandMap; error?: string; issues?: MapIssue[] }>(MAP_ROUTE, {
      method: "PUT",
      body: JSON.stringify({ baseRev: rev, map: form, accepted, dismissed: [] }),
    });
    setBusy(false);
    if (res.ok && res.data.map) {
      const next = decidedOf(res.data.map);
      setForm(next);
      setSaved(next);
      setBaseRev(res.data.map.rev);
      setAccepted([]);
      setConflict(null);
      setNote({ tone: "ok", text: "Saved. New articles are written from this map." });
      router.refresh();
      return;
    }
    if (res.status === 409 && res.data.error === "map_changed" && res.data.map) {
      setConflict(res.data.map);
      return;
    }
    if (res.data.issues?.length) setIssues(res.data.issues);
    setNote({ tone: "err", text: res.data.issues?.length ? "Fix the lines marked below, then save." : errorText(res.data) });
  };

  const research = async () => {
    setBusy(true);
    setNote({ tone: "info", text: "Researching your brand. This takes about a minute." });
    const res = await api<{ map?: BrandMap; filed?: number; error?: string }>(`${MAP_ROUTE}/research`, { method: "POST", body: "{}" });
    setBusy(false);
    if (!res.ok || !res.data.map) {
      setNote({
        tone: "err",
        text: res.status === 0 ? "Research may still be finishing. Refresh the page in a minute." : errorText(res.data),
      });
      return;
    }
    setStarted(true);
    // First time, on a blank map: fill the form with what research found, for one save.
    if (baseRev === 0 && isBlank(form)) {
      const fill = firstRunFill(form, res.data.map.suggestions);
      setForm(fill.decided);
      setAccepted(fill.accepted);
      setFreshSuggestions(res.data.map.suggestions);
      setNote({ tone: "info", text: "Drafted from your website and a web search. Review, edit, then save. Nothing is used until you do." });
    } else {
      setFreshSuggestions(res.data.map.suggestions);
      setNote({ tone: "info", text: res.data.filed ? `Research found ${res.data.filed} new suggestion${res.data.filed === 1 ? "" : "s"}.` : "Research found nothing new." });
    }
    router.refresh();
  };

  if (props.unreadable) {
    return (
      <Banner tone="err">
        Your brand map can&apos;t be read, so articles are being written without it. Nothing here can be changed until it is fixed; contact support.
      </Banner>
    );
  }

  if (!started) {
    return (
      <div className="space-y-4">
        <section className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-neutral-400 px-6 py-10 text-center dark:border-neutral-600">
          <h2 className="text-lg font-semibold">{props.canEdit ? "Start with research" : "Your brand map is empty"}</h2>
          <p className="max-w-lg text-sm text-neutral-600 dark:text-neutral-300">
            {props.canEdit
              ? props.canResearch
                ? "We read your site and your knowledge, search how people talk about your category, and draft the map for you to check. It takes about a minute."
                : "Say what you are, the subjects you want to be known for, and the names you use. Every article is then written from it."
              : "An admin can set it up."}
          </p>
          {props.canEdit ? (
            <div className="flex flex-wrap justify-center gap-2">
              {props.canResearch ? (
                <Button tone="primary" disabled={busy} onClick={research}>
                  Research my brand
                </Button>
              ) : null}
              <Button
                disabled={busy}
                onClick={() => {
                  setStarted(true);
                  setForm({ ...form, identity: { ...form.identity, name: props.defaults.name, site: props.defaults.site } });
                }}
              >
                Fill it in yourself
              </Button>
            </div>
          ) : null}
          <p className="text-xs text-neutral-500">Nothing is used in an article until you save.</p>
        </section>
        {note ? <Banner tone={note.tone}>{note.text}</Banner> : null}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-neutral-500">
          {!props.canEdit
            ? "Only an admin can change the brand map."
            : baseRev === 0
              ? "Not saved yet: articles are written without it until you save."
              : dirty
                ? "Unsaved changes."
                : "All changes saved."}
        </p>
        {props.canEdit ? (
          <div className="flex flex-wrap gap-2">
            {props.canResearch ? (
              <Button disabled={busy} onClick={research}>
                Research again
              </Button>
            ) : null}
            <Button tone="primary" disabled={busy || !dirty} onClick={() => save()}>
              Save brand map
            </Button>
          </div>
        ) : null}
      </div>

      {conflict ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          <span>The brand map was changed elsewhere since you opened it.</span>
          <span className="flex gap-2">
            <Button
              onClick={() => {
                const next = decidedOf(conflict);
                setForm(next);
                setSaved(next);
                setBaseRev(conflict.rev);
                setAccepted([]);
                setConflict(null);
                router.refresh();
              }}
            >
              Load the latest
            </Button>
            <Button tone="primary" disabled={busy} onClick={() => save(conflict.rev)}>
              Save mine anyway
            </Button>
          </span>
        </div>
      ) : null}
      {note ? <Banner tone={note.tone}>{note.text}</Banner> : null}
      {props.research?.notes.length ? (
        <ul className="space-y-0.5 text-xs text-neutral-500">
          {props.research.notes.map((n, i) => (
            <li key={i}>Research note: {n}</li>
          ))}
        </ul>
      ) : null}

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-5">
          <BrandMapIdentity
            value={form.identity}
            onChange={(identity) => setForm({ ...form, identity })}
            issues={issues}
            disabled={!editable}
            findCategory={
              editable && form.identity.category ? (
                <BrandMapLookup
                  name={form.identity.category}
                  kind="category"
                  label="Find identifier"
                  canLookup={props.canLookup}
                  disabled={busy}
                  onUse={(links) =>
                    setForm((f) => ({ ...f, identity: { ...f.identity, categorySameAs: addLinks(f.identity.categorySameAs, links, BRAND_MAP_LIMITS.categorySameAs) } }))
                  }
                />
              ) : null
            }
            findBrand={
              editable && form.identity.name ? (
                <BrandMapLookup
                  name={form.identity.name}
                  kind="brand"
                  label={`Find ${form.identity.name} on Wikidata`}
                  canLookup={props.canLookup}
                  disabled={busy}
                  onUse={(links) =>
                    setForm((f) => ({ ...f, identity: { ...f.identity, profiles: addLinks(f.identity.profiles, links, BRAND_MAP_LIMITS.profiles) } }))
                  }
                />
              ) : null
            }
          />
          <BrandMapSubjects
            subjects={form.subjects}
            onChange={(subjects) => setForm({ ...form, subjects })}
            issues={issues}
            disabled={!editable}
          />
          <BrandMapNames
            names={form.names}
            onChange={(names) => setForm({ ...form, names })}
            issues={issues}
            disabled={!editable}
            find={(n, i) =>
              editable && n.kind !== "audience" && n.kind !== "use_case" ? (
                <BrandMapLookup
                  name={n.name}
                  kind={n.kind}
                  canLookup={props.canLookup}
                  disabled={busy}
                  onUse={(links) =>
                    setForm((f) => ({
                      ...f,
                      names: f.names.map((x, j) => (j === i ? { ...x, sameAs: addLinks(x.sameAs, links, BRAND_MAP_LIMITS.nameSameAs) } : x)),
                    }))
                  }
                />
              ) : null
            }
          />
        </div>
        <div className="min-w-0 space-y-5">
          <BrandMapSuggestions
            key={suggestions.map((s) => s.key).join("|")}
            suggestions={suggestions}
            canEdit={editable}
            busy={busy}
            onAccept={accept}
            onDismiss={dismiss}
          />
          {baseRev > 0 ? <BrandMapMarkup saved={saved} /> : null}
        </div>
      </div>
    </div>
  );
}

/** Add links to a list once each, up to its cap. */
function addLinks(list: BrandMapLink[], links: BrandMapLink[], max: number): BrandMapLink[] {
  const seen = new Set(list.map((l) => normalizeUrl(l.url)));
  const out = [...list];
  for (const l of links) {
    if (out.length >= max || seen.has(normalizeUrl(l.url))) continue;
    seen.add(normalizeUrl(l.url));
    out.push(l);
  }
  return out;
}

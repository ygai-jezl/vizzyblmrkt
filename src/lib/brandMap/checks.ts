import type { BrandMapDecided, BrandMapLink } from "@/lib/types/brandMap";
import { siteOf, sitesOf } from "@/lib/knowledge/site";
import { fold } from "./changes";

/**
 * The checks a save must pass beyond the schema: ids and names unique, a home page on the
 * brand's own site, a profile link off it, an identifier link shaped like what it says it
 * is, and no name both used and avoided. Server-side (it reads registrable domains); the
 * editor shows the issues by their path.
 */

export interface MapIssue {
  /** Where on the map, e.g. "names.3.home". */
  path: string;
  message: string;
}

const WIKIDATA = /^https:\/\/www\.wikidata\.org\/wiki\/Q[1-9]\d*$/;
const WIKIPEDIA = /^https:\/\/[a-z]{2,3}(?:-[a-z]+)?\.wikipedia\.org\/wiki\/[^\s]+$/;

function linkIssue(link: BrandMapLink): string {
  if (link.source === "wikidata" && !WIKIDATA.test(link.url)) return "is not a Wikidata item's address";
  if (link.source === "wikipedia" && !WIKIPEDIA.test(link.url)) return "is not a Wikipedia page's address";
  return "";
}

export function checkDecided(d: BrandMapDecided, opts: { ownSites: (string | null | undefined)[] }): MapIssue[] {
  const issues: MapIssue[] = [];
  const own = sitesOf([d.identity.site, ...opts.ownSites]);
  const onOwnSite = (url: string) => own.has(siteOf(url));

  const ids = new Set<string>();
  const id = (value: string, path: string) => {
    if (ids.has(value)) issues.push({ path, message: "has the same id as another row" });
    ids.add(value);
  };

  const subjectNames = new Map<string, string>();
  d.subjects.forEach((s, i) => {
    id(s.id, `subjects.${i}.id`);
    const k = fold(s.name);
    if (subjectNames.has(k)) issues.push({ path: `subjects.${i}.name`, message: `“${s.name}” is already a subject` });
    subjectNames.set(k, s.name);
    if (s.home && own.size && !onOwnSite(s.home)) issues.push({ path: `subjects.${i}.home`, message: "must be a page on your own site" });
    const texts = new Set<string>();
    s.questions.forEach((q, j) => {
      id(q.id, `subjects.${i}.questions.${j}.id`);
      if (texts.has(fold(q.text))) issues.push({ path: `subjects.${i}.questions.${j}.text`, message: "is already a question here" });
      texts.add(fold(q.text));
    });
  });

  // Every spelling of every name points at one name only.
  const spellings = new Map<string, number>();
  d.names.forEach((n, i) => {
    id(n.id, `names.${i}.id`);
    [n.name, ...n.aliases].forEach((spelling, j) => {
      const k = fold(spelling);
      if (!k) return;
      const owner = spellings.get(k);
      if (owner !== undefined && owner !== i) {
        issues.push({
          path: j === 0 ? `names.${i}.name` : `names.${i}.aliases.${j - 1}`,
          message: `“${spelling}” is already a name or another spelling of ${d.names[owner]!.name}`,
        });
      }
      spellings.set(k, i);
    });
    if (n.home && own.size && !onOwnSite(n.home)) issues.push({ path: `names.${i}.home`, message: "must be a page on your own site" });
    n.sameAs.forEach((link, j) => {
      const problem = linkIssue(link);
      if (problem) issues.push({ path: `names.${i}.sameAs.${j}`, message: problem });
    });
  });

  d.identity.profiles.forEach((link, i) => {
    if (own.size && onOwnSite(link.url)) issues.push({ path: `identity.profiles.${i}`, message: "is on your own site, so it is not a profile elsewhere" });
    const problem = linkIssue(link);
    if (problem) issues.push({ path: `identity.profiles.${i}`, message: problem });
  });
  d.identity.categorySameAs.forEach((link, i) => {
    const problem = linkIssue(link);
    if (problem) issues.push({ path: `identity.categorySameAs.${i}`, message: problem });
  });

  const inUse = new Set([fold(d.identity.name), fold(d.identity.category), ...spellings.keys()].filter(Boolean));
  d.identity.avoid.forEach((a, i) => {
    if (inUse.has(fold(a.term))) issues.push({ path: `identity.avoid.${i}.term`, message: `“${a.term}” is a name you use, so it cannot also be avoided` });
  });
  return issues;
}

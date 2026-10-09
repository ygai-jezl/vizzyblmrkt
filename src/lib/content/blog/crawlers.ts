/**
 * Can the AI answer engines read the article at all? A page their crawlers are kept out
 * of cannot be retrieved, quoted or cited, however well it is written — and the usual
 * reason is a line in the site's robots.txt that nobody remembers adding. This reads a
 * robots.txt the way a crawler does and says which of the AI crawlers it keeps away
 * from a path. We do not host the site, so all we can do is tell the operator.
 * Pure + client-safe.
 */

export interface AiCrawler {
  /** The name robots.txt knows the crawler by (its product token). */
  agent: string;
  /** The answer engine it reads for, in the words an operator knows. */
  engine: string;
}

/** The crawlers behind the answer engines an article is written to be cited by. */
export const AI_CRAWLERS: AiCrawler[] = [
  { agent: "GPTBot", engine: "ChatGPT" },
  { agent: "OAI-SearchBot", engine: "ChatGPT search" },
  { agent: "ChatGPT-User", engine: "ChatGPT" },
  { agent: "ClaudeBot", engine: "Claude" },
  { agent: "Claude-SearchBot", engine: "Claude" },
  { agent: "Claude-User", engine: "Claude" },
  { agent: "PerplexityBot", engine: "Perplexity" },
  { agent: "Perplexity-User", engine: "Perplexity" },
  { agent: "Google-Extended", engine: "Gemini" },
  { agent: "Googlebot", engine: "Google Search and AI Overviews" },
  { agent: "Bingbot", engine: "Bing and Copilot" },
];

/** A crawler's name with the engine it reads for: "GPTBot (ChatGPT)". */
export function crawlerLabel(agent: string): string {
  const known = AI_CRAWLERS.find((c) => c.agent.toLowerCase() === agent.toLowerCase());
  return known ? `${known.agent} (${known.engine})` : agent;
}

interface Rule {
  allow: boolean;
  path: string;
}

interface Group {
  agents: string[];
  rules: Rule[];
}

/** Rules past this are not read: a robots.txt is someone else's text, and may be endless. */
const MAX_RULES = 2000;
const MAX_PATTERN = 600;

/** The groups of a robots.txt: one or more User-agent lines, then the rules for them. */
export function parseRobots(text: string): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  let naming = false; // the last record read was a User-agent line
  let rules = 0;
  for (const raw of (text ?? "").split(/\r?\n/)) {
    const hash = raw.indexOf("#");
    const line = (hash === -1 ? raw : raw.slice(0, hash)).trim();
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (!current || !naming) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      naming = true;
    } else if (key === "allow" || key === "disallow") {
      naming = false;
      if (!current || rules >= MAX_RULES) continue;
      rules += 1;
      current.rules.push({ allow: key === "allow", path: value.slice(0, MAX_PATTERN) });
    }
    // Any other record (Sitemap, Crawl-delay) neither opens a group nor closes one.
  }
  return groups;
}

/**
 * Does a rule's path match? Literal text from the start of the path, `*` for any run of
 * characters, a closing `$` for "and nothing after". Written as a plain scan, not a
 * regular expression: the pattern is a stranger's text, and a pattern full of stars must
 * cost what its length costs and no more.
 */
function matches(rule: string, path: string): boolean {
  const whole = rule.endsWith("$");
  const pattern = whole ? rule.slice(0, -1) : `${rule}*`;
  let p = 0;
  let t = 0;
  let star = -1;
  let resume = 0;
  while (t < path.length) {
    if (p < pattern.length && pattern[p] === "*") {
      star = p;
      resume = t;
      p += 1;
    } else if (p < pattern.length && pattern[p] === path[t]) {
      p += 1;
      t += 1;
    } else if (star !== -1) {
      p = star + 1;
      resume += 1;
      t = resume;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p += 1;
  return p === pattern.length;
}

/** The rules a crawler follows: its own group's when it is named, else everyone's (`*`). */
function rulesFor(groups: Group[], agent: string): Rule[] {
  const name = agent.toLowerCase();
  const named = groups.filter((g) => g.agents.includes(name));
  return (named.length ? named : groups.filter((g) => g.agents.includes("*"))).flatMap((g) => g.rules);
}

/** May a crawler read `path`? The longest matching rule decides, and Allow wins a tie.
 *  An empty Disallow restricts nothing; no matching rule means yes. */
function mayRead(rules: Rule[], path: string): boolean {
  let best: { allow: boolean; length: number } | null = null;
  for (const rule of rules) {
    if (!rule.path || !matches(rule.path, path)) continue;
    if (!best || rule.path.length > best.length || (rule.path.length === best.length && rule.allow)) {
      best = { allow: rule.allow, length: rule.path.length };
    }
  }
  return best ? best.allow : true;
}

/** The AI crawlers this robots.txt keeps away from `path` ("/" = the site's front door). */
export function blockedCrawlers(robotsTxt: string, path = "/"): string[] {
  const groups = parseRobots(robotsTxt);
  const at = path.startsWith("/") ? path.slice(0, 2000) : "/";
  return AI_CRAWLERS.filter((c) => !mayRead(rulesFor(groups, c.agent), at)).map((c) => c.agent);
}

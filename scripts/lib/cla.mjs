// The CLA check: is everyone whose work is in a pull request covered by a contributor licence
// agreement? scripts/check-cla.mjs runs it for one pull request, from .github/workflows/cla.yml.
// Pure functions, Node built-ins only, so the workflow needs no npm ci.
//
// docs/cla/policy.json (maintainers only) lists the accepted agreements, the exempt logins, the
// AI coding tools' addresses and logins, and the organisations that signed. Each person who
// signed has one file, docs/cla/signatures/<login>.json, added in their own pull request.
// "Trusted" files are read from the base branch (dev or main), never from the pull request,
// except the author's own new signature file. The check fails closed: anything it can't read or
// see in full is a failure, never a pass.

import { parseArgs } from "node:util";

export const CLA_DIR = "docs/cla/";
export const POLICY_PATH = "docs/cla/policy.json";
export const SIGNATURES_DIR = "docs/cla/signatures/";
/** The branches a pull request may target for the check to run. */
export const BASE_BRANCHES = ["dev", "main"];
/** GitHub lists at most this many commits and files for a pull request. */
export const MAX_COMMITS = 250;
export const MAX_FILES = 3000;

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const INDIVIDUAL = /^individual-v[1-9][0-9]*$/;
const ENTITY = /^entity-v[1-9][0-9]*$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PR = /^[1-9][0-9]{0,8}$/;
const NOREPLY = /^(?:[0-9]+\+)?([^@\s]+)@users\.noreply\.github\.com$/i;

/**
 * @typedef {{ login: string, why: string }} Exempt
 * @typedef {{ id: string, cla: string, signedAt: string, logins: string[], recordedBy: string }} Entity
 * @typedef {{ version: 1, accepted: string[], exempt: Exempt[], ai: { emails: string[], logins: string[] }, entities: Entity[] }} Policy
 * @typedef {{ login: string, cla: string, signedAt: string }} Signature
 *
 * The parts of GitHub's objects the check reads.
 * @typedef {{ ref?: string, sha?: string, repo?: { full_name?: string } | null }} Branch
 * @typedef {{ user?: { login?: string } | null, base?: Branch, head?: Branch, commits?: number, changed_files?: number }} Pull
 * @typedef {{ sha?: string, author?: { login?: string } | null, commit?: { author?: { email?: string } | null, message?: string } }} Commit
 * @typedef {{ filename: string, status: string, previous_filename?: string }} PullFile
 *
 * @typedef {(path: string) => Promise<string | null> | string | null} Reader
 *   A file's text, or null when it doesn't exist. Throws when it can't be read.
 *
 * @typedef {object} ClaResult
 * @property {boolean} ok
 * @property {string} author the pull request's author
 * @property {boolean} promotion a dev to main promotion in the same repository
 * @property {string | null} trustedRef where trusted files were read
 * @property {string} individualCla the individual agreement to sign, such as individual-v1
 * @property {string[]} errors why the check couldn't finish (it fails closed)
 * @property {string[]} uncovered logins with no agreement on record
 * @property {string[]} unlinked short shas of commits whose author has no GitHub account
 * @property {string[]} coAuthors short shas of commits with a human co-author who isn't covered
 * @property {string[]} register files in docs/cla this pull request may not change
 * @property {string} ownSignature why the author's own new signature file was refused ("" if not)
 * @property {{ login: string, how: string }[]} covered who is covered, and how
 * @property {number} aiCommits commits by an AI coding tool, counted as the author's
 */

// ---------------------------------------------------------------------------
// Small checks
// ---------------------------------------------------------------------------

/**
 * @param {unknown} x
 * @returns {x is Record<string, unknown>}
 */
function isObject(x) {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * @param {unknown} x
 * @returns {x is string[]}
 */
function isStringList(x) {
  return Array.isArray(x) && x.every((v) => typeof v === "string" && v.trim() !== "");
}

/**
 * A GitHub login (bots end in [bot]).
 * @param {unknown} x
 * @returns {x is string}
 */
export function isLogin(x) {
  return typeof x === "string" && LOGIN.test(x);
}

/**
 * A real calendar date written YYYY-MM-DD.
 * @param {unknown} x
 */
function isDate(x) {
  if (typeof x !== "string") return false;
  const m = x.match(DATE);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === x;
}

/**
 * The signature file for a login.
 * @param {string} login
 */
export function signaturePath(login) {
  return `${SIGNATURES_DIR}${String(login).toLowerCase()}.json`;
}

/**
 * The first seven characters of a commit sha, or "unknown".
 * @param {unknown} sha
 */
function shortSha(sha) {
  return typeof sha === "string" && /^[0-9a-f]{7,40}$/.test(sha) ? sha.slice(0, 7) : "unknown";
}

/**
 * The first line of an error, for a message.
 * @param {unknown} err
 */
function firstLine(err) {
  const text = err instanceof Error ? err.message : String(err);
  return text.split(/\r?\n/)[0].slice(0, 300);
}

// ---------------------------------------------------------------------------
// The policy and signature files
// ---------------------------------------------------------------------------

/**
 * docs/cla/policy.json, checked. Logins, AI addresses and AI logins come back in lower case.
 * @param {string} text
 * @returns {{ policy: Policy, error?: undefined } | { policy?: undefined, error: string }}
 */
export function parsePolicy(text) {
  let data;
  try {
    data = JSON.parse(String(text));
  } catch {
    return { error: "isn't valid JSON" };
  }
  if (!isObject(data)) return { error: "isn't a JSON object" };
  if (data.version !== 1) return { error: '"version" must be 1' };
  const { accepted, exempt, ai, entities } = data;
  if (!isStringList(accepted) || !accepted.every((id) => INDIVIDUAL.test(id) || ENTITY.test(id))) {
    return { error: '"accepted" must list agreement ids such as individual-v1 and entity-v1' };
  }
  if (!Array.isArray(exempt) || !exempt.every((e) => isObject(e) && isLogin(e.login) && typeof e.why === "string" && e.why.trim() !== "")) {
    return { error: '"exempt" must list { "login", "why" } entries' };
  }
  if (!isObject(ai) || !isStringList(ai.emails) || !ai.emails.every((e) => /^[^@\s]+@[^@\s]+$/.test(e)) || !Array.isArray(ai.logins) || !ai.logins.every(isLogin)) {
    return { error: '"ai" must hold "emails" (addresses) and "logins" (GitHub logins)' };
  }
  const entityOk = (/** @type {unknown} */ e) =>
    isObject(e) &&
    typeof e.id === "string" &&
    e.id.trim() !== "" &&
    typeof e.cla === "string" &&
    ENTITY.test(e.cla) &&
    isDate(e.signedAt) &&
    Array.isArray(e.logins) &&
    e.logins.length > 0 &&
    e.logins.every(isLogin) &&
    typeof e.recordedBy === "string" &&
    e.recordedBy.trim() !== "";
  if (!Array.isArray(entities) || !entities.every(entityOk)) {
    return { error: '"entities" must list { "id", "cla", "signedAt", "logins", "recordedBy" } entries' };
  }
  return {
    policy: {
      version: 1,
      accepted: [...accepted],
      exempt: exempt.map((e) => ({ login: String(e.login).toLowerCase(), why: String(e.why) })),
      ai: { emails: ai.emails.map((e) => e.toLowerCase()), logins: ai.logins.map((l) => String(l).toLowerCase()) },
      entities: entities.map((e) => ({
        id: String(e.id),
        cla: String(e.cla),
        signedAt: String(e.signedAt),
        logins: /** @type {string[]} */ (e.logins).map((l) => l.toLowerCase()),
        recordedBy: String(e.recordedBy),
      })),
    },
  };
}

/**
 * One signature file, checked against the login its name gives: a JSON object with exactly
 * "login" (that login, in any letter case), "cla" (an individual agreement id) and "signedAt"
 * (YYYY-MM-DD). Whether the policy accepts that agreement is checked by the caller.
 * @param {string} text
 * @param {string} login
 * @returns {{ signature: Signature, error?: undefined } | { signature?: undefined, error: string }}
 */
export function parseSignature(text, login) {
  let data;
  try {
    data = JSON.parse(String(text));
  } catch {
    return { error: "isn't valid JSON" };
  }
  if (!isObject(data)) return { error: "isn't a JSON object" };
  if (Object.keys(data).sort().join(",") !== "cla,login,signedAt") {
    return { error: 'must hold exactly the keys "login", "cla" and "signedAt", and nothing else' };
  }
  if (typeof data.login !== "string" || data.login.toLowerCase() !== String(login).toLowerCase()) {
    return { error: `"login" must be ${login}, the same as the file name` };
  }
  if (typeof data.cla !== "string" || !INDIVIDUAL.test(data.cla)) {
    return { error: '"cla" must name an individual agreement, such as individual-v1' };
  }
  if (!isDate(data.signedAt)) return { error: '"signedAt" must be a date written YYYY-MM-DD' };
  return { signature: { login: data.login, cla: data.cla, signedAt: data.signedAt } };
}

// ---------------------------------------------------------------------------
// Commits and pull requests
// ---------------------------------------------------------------------------

/**
 * The address on each Co-authored-by line of a commit message, in lower case, each once.
 * A line with no address in angle brackets, or more than one, gives "", which no rule
 * covers: "Pat <pat@...>, Claude <noreply@...>" must not pass as the AI tool's line.
 * @param {string | undefined | null} message
 * @returns {string[]}
 */
export function coAuthors(message) {
  const out = new Set();
  for (const line of String(message ?? "").split(/\r?\n/)) {
    const trailer = line.match(/^\s*co-authored-by\s*:(.*)$/i);
    if (!trailer) continue;
    const value = trailer[1];
    const oneAddress = value.split("<").length === 2 && value.split(">").length === 2;
    const email = oneAddress ? value.match(/<([^<>\s]+)>\s*$/) : null;
    out.add(email ? email[1].toLowerCase() : "");
  }
  return [...out];
}

/**
 * The login in a GitHub noreply address (<id>+<login>@users.noreply.github.com or
 * <login>@users.noreply.github.com), in lower case, or null.
 * @param {string} email
 * @returns {string | null}
 */
export function noreplyLogin(email) {
  const m = String(email).match(NOREPLY);
  return m && isLogin(m[1]) ? m[1].toLowerCase() : null;
}

/**
 * A promotion: dev to main within the same repository. A fork's branch named dev is not one.
 * @param {Pull | null | undefined} pull
 */
export function isPromotion(pull) {
  const head = pull?.head;
  const base = pull?.base;
  const headRepo = head?.repo?.full_name;
  return typeof headRepo === "string" && headRepo !== "" && headRepo === base?.repo?.full_name && head?.ref === "dev" && base?.ref === "main";
}

/**
 * Where to read trusted files: the base branch's tip (dev or main), so a re-run sees signatures
 * merged since; for a promotion, dev's head commit, since every commit and signature on dev
 * came through a checked pull request or the maintainer. Null when the base isn't dev or main.
 * @param {Pull | null | undefined} pull
 * @returns {string | null}
 */
export function trustedRef(pull) {
  const base = pull?.base?.ref;
  if (typeof base !== "string" || !BASE_BRANCHES.includes(base)) return null;
  if (isPromotion(pull)) {
    const sha = pull?.head?.sha;
    return typeof sha === "string" && FULL_SHA.test(sha) ? sha : null;
  }
  return base;
}

// ---------------------------------------------------------------------------
// gh arguments: GET requests only (never -f, -F, --field or --method)
// ---------------------------------------------------------------------------

/** @param {string} repo */
function checkRepo(repo) {
  if (!REPO.test(String(repo)) || /(^|\/)\.\.?(\/|$)/.test(String(repo))) throw new Error(`not a repository: ${repo}`);
}

/** @param {string} pr */
function checkPr(pr) {
  if (!PR.test(String(pr))) throw new Error(`not a pull request number: ${pr}`);
}

/**
 * gh arguments that read one file's raw text at a ref.
 * @param {string} repo
 * @param {string} path
 * @param {string} ref
 */
export function ghContentArgs(repo, path, ref) {
  checkRepo(repo);
  const encoded = String(path).split("/").map(encodeURIComponent).join("/");
  return ["api", "-H", "Accept: application/vnd.github.raw", `repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`];
}

/**
 * gh arguments that list a pull request's commits or files, every page.
 * @param {string} repo
 * @param {string} pr
 * @param {"commits" | "files"} kind
 */
export function ghListArgs(repo, pr, kind) {
  checkRepo(repo);
  checkPr(pr);
  if (kind !== "commits" && kind !== "files") throw new Error(`not a list: ${kind}`);
  return ["api", "--paginate", "--slurp", `repos/${repo}/pulls/${pr}/${kind}?per_page=100`];
}

/**
 * gh arguments that read the pull request itself.
 * @param {string} repo
 * @param {string} pr
 */
export function ghPullArgs(repo, pr) {
  checkRepo(repo);
  checkPr(pr);
  return ["api", `repos/${repo}/pulls/${pr}`];
}

/**
 * gh api --paginate --slurp gives a list of pages, each a list: one list of the items.
 * @param {unknown} slurped
 * @returns {unknown[]}
 */
export function flatten(slurped) {
  if (!Array.isArray(slurped)) throw new Error("expected a list of pages");
  return slurped.flatMap((page) => {
    if (!Array.isArray(page)) throw new Error("expected each page to be a list");
    return page;
  });
}

/**
 * The command line of scripts/check-cla.mjs, checked: --repo owner/name, --pr a number, and
 * optional --summary (a file to append the summary to) and --trusted-dir (dry runs only).
 * @param {string[]} argv
 * @returns {{ repo: string, pr: string, summary: string, trustedDir: string }}
 */
export function parseCheckArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      repo: { type: "string" },
      pr: { type: "string" },
      summary: { type: "string" },
      "trusted-dir": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  const repo = values.repo ?? "";
  const pr = values.pr ?? "";
  checkRepo(repo);
  checkPr(pr);
  return { repo, pr, summary: values.summary ?? "", trustedDir: values["trusted-dir"] ?? "" };
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/**
 * A result that failed before the check could look at anyone.
 * @param {string} error
 * @param {Partial<ClaResult>} [fields]
 * @returns {ClaResult}
 */
export function failedResult(error, fields = {}) {
  return {
    ok: false,
    author: "",
    promotion: false,
    trustedRef: null,
    individualCla: "individual-v1",
    errors: [error],
    uncovered: [],
    unlinked: [],
    coAuthors: [],
    register: [],
    ownSignature: "",
    covered: [],
    aiCommits: 0,
    ...fields,
  };
}

/**
 * Check one pull request. Who is checked: its author, each commit's author and each human
 * co-author. A commit by an AI coding tool (policy.ai) counts as the author's, and AI
 * Co-authored-by lines are ignored. A login is covered when it is exempt, has a valid trusted
 * signature, is in an organisation's agreement, or is the author adding their own valid
 * signature file in this pull request.
 *
 * @param {{ pull: Pull | null | undefined, commits: Commit[], files: PullFile[] }} input
 * @param {{ readTrusted: Reader, readHead: Reader }} read
 *   readTrusted reads at trustedRef(pull), readHead at the pull request's head.
 * @returns {Promise<ClaResult>}
 */
export async function checkCla({ pull, commits, files }, { readTrusted, readHead }) {
  const author = pull?.user?.login;
  if (!pull || typeof author !== "string" || author === "") return failedResult("The pull request could not be read.");
  const base = pull.base?.ref;
  if (typeof base !== "string" || !BASE_BRANCHES.includes(base)) {
    const shown = typeof base === "string" ? base.replace(/[^\w./-]/g, "").slice(0, 100) : "unknown";
    return failedResult(`The pull request is not to dev or main (its base is ${shown}), so the check can't run.`, { author });
  }
  const promotion = isPromotion(pull);
  const ref = trustedRef(pull);
  if (!ref) return failedResult("The pull request's head commit could not be read.", { author, promotion });
  const fields = { author, promotion, trustedRef: ref };

  try {
    return await check(pull, author, promotion, ref, commits, files, readTrusted, readHead);
  } catch (err) {
    return failedResult(`The check could not finish: ${firstLine(err)}`, fields);
  }
}

/**
 * @param {Pull} pull
 * @param {string} author
 * @param {boolean} promotion
 * @param {string} ref
 * @param {Commit[]} commits
 * @param {PullFile[]} files
 * @param {Reader} readTrusted
 * @param {Reader} readHead
 * @returns {Promise<ClaResult>}
 */
async function check(pull, author, promotion, ref, commits, files, readTrusted, readHead) {
  const fields = { author, promotion, trustedRef: ref };

  const policyText = await readTrusted(POLICY_PATH);
  if (policyText === null) return failedResult(`${POLICY_PATH} is missing at ${ref}.`, fields);
  const parsed = parsePolicy(policyText);
  if (!parsed.policy) return failedResult(`${POLICY_PATH} at ${ref} ${parsed.error}.`, fields);
  const policy = parsed.policy;
  const individualCla = [...policy.accepted].filter((id) => INDIVIDUAL.test(id)).pop() ?? "individual-v1";
  Object.assign(fields, { individualCla });

  if (!Array.isArray(commits) || !Array.isArray(files) || typeof pull.commits !== "number" || typeof pull.changed_files !== "number") {
    return failedResult("The pull request's commits or files could not be read.", fields);
  }
  if (commits.length < pull.commits) {
    return failedResult(
      `GitHub listed ${commits.length} of this pull request's ${pull.commits} commits (it lists ${MAX_COMMITS} at most), so the check can't see them all. Split the pull request, or a maintainer merges it with the ruleset bypass.`,
      fields,
    );
  }
  if (files.length < pull.changed_files) {
    return failedResult(
      `GitHub listed ${files.length} of this pull request's ${pull.changed_files} changed files (it lists ${MAX_FILES} at most), so the check can't see them all. Split the pull request, or a maintainer merges it with the ruleset bypass.`,
      fields,
    );
  }

  const authorLower = author.toLowerCase();
  const ownFile = signaturePath(author);
  const addsOwnFile = files.some((f) => f?.filename === ownFile && f.status === "added" && !f.previous_filename);
  const aiEmails = new Set(policy.ai.emails);
  const aiLogins = new Set(policy.ai.logins);
  const exempt = new Set(policy.exempt.map((e) => e.login));
  let ownSignature = "";

  /** @type {Map<string, Promise<string>>} login (lower case) to how it is covered, "" if not */
  const coverage = new Map();
  /** @param {string} login */
  const coveredHow = (login) => {
    const lower = login.toLowerCase();
    if (!coverage.has(lower)) {
      coverage.set(
        lower,
        (async () => {
          if (!isLogin(lower)) return "";
          if (exempt.has(lower)) return "exempt";
          if (policy.entities.some((e) => policy.accepted.includes(e.cla) && e.logins.includes(lower))) return "an organisation's agreement";
          const trusted = await readTrusted(signaturePath(lower));
          if (trusted !== null) {
            const sig = parseSignature(trusted, lower);
            if (sig.signature && policy.accepted.includes(sig.signature.cla)) return "signed";
          }
          if (lower === authorLower && addsOwnFile) {
            const head = await readHead(ownFile);
            if (head === null) {
              ownSignature = `${ownFile} could not be found at the pull request's head.`;
              return "";
            }
            const sig = parseSignature(head, lower);
            if (!sig.signature) {
              ownSignature = `${ownFile} ${sig.error}.`;
              return "";
            }
            if (!policy.accepted.includes(sig.signature.cla)) {
              ownSignature = `${ownFile} names ${sig.signature.cla}, which isn't an accepted agreement.`;
              return "";
            }
            return "signing in this pull request";
          }
          return "";
        })(),
      );
    }
    return /** @type {Promise<string>} */ (coverage.get(lower));
  };

  // Who is checked: the author, then each commit's author (AI commits count as the author's).
  const logins = [author];
  const unlinked = [];
  let aiCommits = 0;
  for (const c of commits) {
    const email = String(c?.commit?.author?.email ?? "").toLowerCase();
    const login = c?.author?.login;
    const loginLower = typeof login === "string" ? login.toLowerCase() : "";
    if ((email && aiEmails.has(email)) || (loginLower && aiLogins.has(loginLower))) {
      aiCommits++;
    } else if (typeof login === "string" && login !== "") {
      if (!logins.some((l) => l.toLowerCase() === loginLower)) logins.push(login);
    } else {
      unlinked.push(shortSha(c?.sha));
    }
  }

  /** @type {{ login: string, how: string }[]} */
  const covered = [];
  const uncovered = [];
  for (const login of logins) {
    const how = await coveredHow(login);
    if (how) covered.push({ login, how });
    else uncovered.push(login);
  }

  // Author addresses of commits whose author is covered: a co-author line with one of them is
  // that person, already checked.
  const coveredEmails = new Set();
  for (const c of commits) {
    const email = String(c?.commit?.author?.email ?? "").toLowerCase();
    const login = c?.author?.login;
    if (email && typeof login === "string" && login !== "" && !aiEmails.has(email) && (await coveredHow(login))) coveredEmails.add(email);
  }

  // Each human co-author must be covered. Only the short sha is named, never a name or email.
  const coAuthorShas = [];
  for (const c of commits) {
    const own = String(c?.commit?.author?.email ?? "").toLowerCase();
    for (const email of coAuthors(c?.commit?.message)) {
      if (email && aiEmails.has(email)) continue;
      const fromNoreply = email ? noreplyLogin(email) : null;
      if (fromNoreply && aiLogins.has(fromNoreply)) continue;
      let ok = false;
      if (fromNoreply) {
        ok = Boolean(await coveredHow(fromNoreply));
        if (!ok && !uncovered.some((l) => l.toLowerCase() === fromNoreply)) uncovered.push(fromNoreply);
      } else {
        ok = email !== "" && (email === own || coveredEmails.has(email));
      }
      if (!ok) {
        const sha = shortSha(c?.sha);
        if (!coAuthorShas.includes(sha)) coAuthorShas.push(sha);
      }
    }
  }

  // Changes to docs/cla: only the author's own new signature file, unless the author is exempt
  // or this is a promotion. GitHub's file list is the diff against the merge base, so a branch
  // cut before someone else signed doesn't show their file.
  const register = [];
  if (!promotion && !exempt.has(authorLower)) {
    for (const f of files) {
      const names = [f?.filename, f?.previous_filename].filter((n) => typeof n === "string");
      if (!names.some((n) => n.startsWith(CLA_DIR))) continue;
      const own = f.filename === ownFile && f.status === "added" && !f.previous_filename;
      if (!own) register.push(String(f.filename));
    }
  }

  const ok = uncovered.length === 0 && unlinked.length === 0 && coAuthorShas.length === 0 && register.length === 0;
  return {
    ok,
    author,
    promotion,
    trustedRef: ref,
    individualCla,
    errors: [],
    uncovered,
    unlinked,
    coAuthors: coAuthorShas,
    register,
    ownSignature: uncovered.some((l) => l.toLowerCase() === authorLower) ? ownSignature : "",
    covered,
    aiCommits,
  };
}

// ---------------------------------------------------------------------------
// The summary
// ---------------------------------------------------------------------------

/**
 * Text as inline code, safe in Markdown: no backticks or line breaks, and not too long.
 * @param {unknown} text
 */
function code(text) {
  const clean = String(text).replace(/[`\r\n]/g, "").slice(0, 200);
  return `\`${clean}\``;
}

/**
 * The job summary, in plain words: who is not covered and how to sign.
 * @param {ClaResult} result
 * @returns {string}
 */
export function summaryMarkdown(result) {
  const lines = ["## CLA check", ""];
  if (result.promotion && result.trustedRef) {
    lines.push(`This pull request promotes dev to main, so signatures were read at dev's head commit ${code(result.trustedRef.slice(0, 7))}.`, "");
  }
  if (result.ok) {
    lines.push("Everyone whose work is in this pull request is covered by a contributor licence agreement.", "");
    for (const c of result.covered) lines.push(`- ${code(c.login)}: ${c.how}`);
    if (result.aiCommits) lines.push(`- ${result.aiCommits} commit${result.aiCommits === 1 ? "" : "s"} by an AI coding tool, counted as the author's work`);
    lines.push("", "The terms of the agreement are in docs/cla/individual.md.");
    return `${lines.join("\n")}\n`;
  }

  lines.push("The CLA check failed.", "");
  for (const e of result.errors) lines.push(e, "");
  if (result.uncovered.length) {
    lines.push(`**Not covered by a contributor licence agreement:** ${result.uncovered.map(code).join(", ")}`, "");
  }
  if (result.ownSignature) lines.push(`**Your signature file:** ${result.ownSignature.replace(/[\r\n]/g, " ")}`, "");
  if (result.unlinked.length) {
    lines.push(
      `**Commits whose author has no GitHub account:** ${result.unlinked.map(code).join(", ")}. Add the commit's email address to your GitHub account (Settings, Emails), or commit again with an address it has, then push.`,
      "",
    );
  }
  if (result.coAuthors.length) {
    lines.push(
      `**Commits with a co-author who is not covered:** ${result.coAuthors.map(code).join(", ")}. Every human co-author needs an agreement too. Write their GitHub noreply address in the Co-authored-by line. They sign in a pull request of their own, and once that is merged, this check passes when it runs again.`,
      "",
    );
  }
  if (result.register.length) {
    lines.push(
      `**Files in docs/cla this pull request may not change:** ${result.register.map(code).join(", ")}. A pull request may only add its author's own signature file. Maintainers change the rest.`,
      "",
    );
  }
  // A pull request may add only its author's own signature file, so only the author signs here.
  // Anyone else not covered (another commit's author, or a co-author) signs in their own.
  const authorLower = result.author.toLowerCase();
  const authorUncovered = result.uncovered.some((l) => l.toLowerCase() === authorLower);
  const others = result.uncovered.filter((l) => l.toLowerCase() !== authorLower);
  const othersUncovered = others.length > 0 || result.coAuthors.length > 0;
  if (result.errors.length === 0 && (authorUncovered || othersUncovered)) {
    if (authorUncovered) {
      const login = isLogin(result.author) ? result.author : "<your login>";
      lines.push(
        "### How to sign",
        "",
        "1. Read the terms in docs/cla/individual.md.",
        `2. In this pull request, add the file ${code(signaturePath(login))} (your GitHub login in lowercase) holding exactly:`,
        "",
        "   ```json",
        `   { "login": "${login}", "cla": "${result.individualCla}", "signedAt": "YYYY-MM-DD" }`,
        "   ```",
        "",
        "3. Push. The check runs again.",
        "",
      );
    }
    if (othersUncovered) {
      const files = others.filter(isLogin).map((l) => code(signaturePath(l)));
      lines.push(
        "### How others sign",
        "",
        "Anyone named above who is not this pull request's author signs in a pull request of their own. This one may only add its author's own signature file.",
        "",
        "1. They read the terms in docs/cla/individual.md.",
        `2. They open a pull request that adds only the file ${code(signaturePath("<their login>"))} (their GitHub login in lowercase) holding exactly:`,
        "",
        "   ```json",
        `   { "login": "<their login>", "cla": "${result.individualCla}", "signedAt": "YYYY-MM-DD" }`,
        "   ```",
        "",
        "3. Once that is merged, this check passes when it runs again: push to this pull request, or ask a maintainer to run it.",
        "",
      );
      if (files.length) lines.push(`Their files: ${files.join(", ")}.`, "");
    }
    lines.push(
      "If your employer has rights in your work, it signs docs/cla/entity.md instead, by email. If you renamed your GitHub account, sign again under the new login. The terms are in docs/cla/individual.md.",
    );
  } else {
    lines.push("The terms of the agreement are in docs/cla/individual.md, and how to sign is in CONTRIBUTING.md.");
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

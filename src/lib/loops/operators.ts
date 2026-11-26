import type { TenantContext } from "@/lib/tenant/types";

/**
 * Who sees this copy's own learning loop (Work plan decision 14, loops v6 decision 6): the people
 * the deployment setting LOOPS_OPERATOR_EMAILS names, and the repo LOOPS_SOURCE_REPO names as this
 * copy's own source. Both are empty in public code (.env.example) and set only in a deployment's
 * own settings file. Empty means no one, and no repo.
 *
 * What they gate: on Work, the loop line typed link (on a task with a pull request from that repo)
 * and Used measures that count this copy's own AI purposes, ontology types and LOOPS kinds; later,
 * the Loops section. Every other business never sees one.
 *
 * Server only: it reads process.env, and pages pass the answer down. Never a NEXT_PUBLIC setting.
 */

/** The comma separated list, trimmed and lower cased, with blanks dropped. */
function list(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * The signed in person is a loops operator: their address equals one LOOPS_OPERATOR_EMAILS names,
 * ignoring case, and their provider verified it. An agent's context carries no address, so Vizzy
 * is never one.
 */
export function isLoopsOperator(ctx: Pick<TenantContext, "email" | "emailVerified">): boolean {
  const email = (ctx.email ?? "").trim().toLowerCase();
  if (!email || ctx.emailVerified !== true) return false;
  return list(process.env.LOOPS_OPERATOR_EMAILS).includes(email);
}

/** This copy's own source repo as its connection names it (owner/name or a GitLab path), lower cased; null when unset. */
export function loopsSourceRepo(): string | null {
  const repo = (process.env.LOOPS_SOURCE_REPO ?? "").trim().toLowerCase();
  return repo || null;
}

/** A pull request link's repo is this copy's own source (ignoring case). False while the setting is empty. */
export function isLoopsSourceRepo(repo: string): boolean {
  const own = loopsSourceRepo();
  return own !== null && repo.trim().toLowerCase() === own;
}

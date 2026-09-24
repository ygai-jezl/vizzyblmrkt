import { randomUUID } from "node:crypto";
import { signState, verifyState } from "@/lib/integrations/crypto";
import { setTenantGitConnection } from "@/lib/tenant";
import type { GitHubAccountType, UserInstallation } from "@/lib/integrations/githubApp";

/**
 * The signed steps of connecting the read-only GitHub App. Every token is bound
 * to the tenant and good for ten minutes:
 *  - install: GitHub's install page (the original flow);
 *  - link:    GitHub's authorize page. May carry an install GitHub already told us
 *             about (`i`), listed first when this person can access it;
 *  - choose:  the installs this person can access, for "Which GitHub account?".
 */
export const CONNECT_STATE_MAX_AGE_MS = 10 * 60 * 1000;

export function connectState(tenantId: string, step: "install" | "link", installationId?: number): string {
  return signState({
    t: tenantId,
    p: "github",
    n: randomUUID(),
    ts: Date.now(),
    m: step,
    ...(installationId ? { i: installationId } : {}),
  });
}

export interface InstallChoice {
  installationId: number;
  accountLogin: string | null;
  accountType: GitHubAccountType | null;
  repositorySelection: string | null;
}

const MAX_CHOICES = 30;

/** The installs GitHub confirmed this person can use, signed so the pick can't name any other. */
export function chooseToken(tenantId: string, installs: UserInstallation[]): string {
  return signState({
    t: tenantId,
    p: "github",
    n: randomUUID(),
    ts: Date.now(),
    m: "choose",
    c: installs.slice(0, MAX_CHOICES).map((i) => ({ i: i.installationId, l: i.accountLogin, y: i.accountType, s: i.repositorySelection })),
  });
}

/** The choices in a `choose` token, or null if it's forged, expired or another tenant's. */
export function readChooseToken(token: string, tenantId: string, now = Date.now()): InstallChoice[] | null {
  const s = verifyState(token);
  if (!s || s.m !== "choose" || s.t !== tenantId || s.p !== "github") return null;
  if (typeof s.ts !== "number" || now - s.ts > CONNECT_STATE_MAX_AGE_MS) return null;
  if (!Array.isArray(s.c)) return null;
  const choices: InstallChoice[] = [];
  for (const raw of s.c as Array<Record<string, unknown>>) {
    const id = raw?.i;
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) continue;
    choices.push({
      installationId: id,
      accountLogin: typeof raw.l === "string" ? raw.l : null,
      accountType: raw.y === "User" || raw.y === "Organization" ? raw.y : null,
      repositorySelection: typeof raw.s === "string" ? raw.s : null,
    });
  }
  return choices;
}

/** Save the install as the tenant's GitHub connection. Only its id is stored — never a token. */
export async function saveAppConnection(
  tenantId: string,
  connectedBy: string | undefined,
  inst: { installationId: number; accountLogin: string | null; accountType: GitHubAccountType | null },
): Promise<void> {
  await setTenantGitConnection(tenantId, "github", {
    provider: "github",
    kind: "app",
    installationId: inst.installationId,
    accountLogin: inst.accountLogin ?? undefined,
    accountType: inst.accountType ?? undefined,
    scope: "contents:read",
    connectedBy,
    connectedAt: new Date().toISOString(),
  });
}

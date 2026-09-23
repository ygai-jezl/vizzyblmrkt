import type { Firestore } from "firebase-admin/firestore";
import { databaseIdForRegion, type Region } from "../config";
import { getDb } from "../firestore";
import { cloneAndCollect, scrubCredentials } from "../sources/git";
import { fetchGitToken } from "../gitToken";
import { RepoReader, type RepoFile } from "./reader";
import { analyseRepo, type AnalysisPass, type ModelClient } from "./analyst";
import { verifyProductMap } from "./verify";
import { vertexModel } from "./vertex";

/**
 * "Learn from your repo": clone the connection's repos READ-ONLY, let the
 * analysis agent answer the question set, verify its evidence, and write the
 * product map back onto the tenant's `repo_analyses` doc for review in the app.
 *
 * Only the map (with ≤240-char redacted evidence excerpts) is stored — never the
 * source. The clone lives in a temp dir that cloneAndCollect always removes.
 */

export const ANALYSIS_COLLECTION = "repo_analyses";
const MAX_REPOS = 3;

export interface ProductMapEnv {
  analysisId: string;
  tenantId: string;
  region: Region;
  project: string;
}

interface AnalysisRepo {
  provider: "github" | "gitlab";
  url: string;
  ref: string | null;
  label: string;
}

export function readProductMapEnv(env: NodeJS.ProcessEnv = process.env): ProductMapEnv {
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`missing required env ${k}`);
    return v;
  };
  const region = need("REGION") as Region;
  if (!["us", "eu", "asia"].includes(region)) throw new Error(`invalid REGION '${region}'`);
  return { analysisId: need("ANALYSIS_ID"), tenantId: need("TENANT_ID"), region, project: need("GOOGLE_CLOUD_PROJECT") };
}

export interface ProductMapDeps {
  db?: Firestore;
  model?: ModelClient;
  collect?: typeof cloneAndCollect;
  token?: typeof fetchGitToken;
  now?: () => string;
  /** Tests: run one general pass instead of the parallel focused passes. */
  passes?: AnalysisPass[];
}

export async function runProductMap(env: ProductMapEnv = readProductMapEnv(), deps: ProductMapDeps = {}): Promise<void> {
  const db = deps.db ?? getDb(databaseIdForRegion(env.region));
  const now = deps.now ?? (() => new Date().toISOString());
  const ref = db.collection(ANALYSIS_COLLECTION).doc(env.analysisId);

  // Ownership guard: the ids came from trusted env, but check the doc anyway.
  const snap = await ref.get();
  if (!snap.exists) throw new Error("analysis_not_found");
  const doc = snap.data() as { tenantId?: string; status?: string; repos?: AnalysisRepo[]; productName?: string };
  if (doc.tenantId !== env.tenantId) throw new Error("analysis_tenant_mismatch");
  if (doc.status !== "queued") throw new Error(`analysis_not_queued:${doc.status}`);
  await ref.update({ status: "running", startedAt: now(), error: null });

  try {
    const repos = (doc.repos ?? []).slice(0, MAX_REPOS);
    if (repos.length === 0) throw new Error("no_repos");
    const files: RepoFile[] = [];
    for (const repo of repos) {
      const token = await (deps.token ?? fetchGitToken)(env.tenantId, repo.provider);
      const { files: got } = await (deps.collect ?? cloneAndCollect)({
        source: repo.provider,
        sourceUri: repo.url,
        ref: repo.ref,
        token,
        extraFileNames: ["package.json"],
      });
      for (const f of got) files.push({ repo: repo.label, path: f.path, text: f.text });
    }
    if (files.length === 0) throw new Error("no_readable_files");

    const reader = new RepoReader(files);
    const model = deps.model ?? vertexModel({ project: env.project, region: env.region });
    const result = await analyseRepo(reader, model, {
      productName: doc.productName ?? "the product",
      passes: deps.passes,
      repos: repos.map((r) => `${r.label} — ${r.url.replace(/^https:\/\//, "")}${r.ref ? ` @ ${r.ref}` : ""}`),
    });
    const verified = verifyProductMap(result.map, reader);
    await ref.update({
      status: result.stats.submitted ? "done" : "incomplete",
      map: verified.map,
      stats: { files: reader.size, ...result.stats, dropped: result.dropped, ...verified.stats },
      finishedAt: now(),
    });
  } catch (err) {
    const msg = scrubCredentials(err instanceof Error ? err.message : "error").slice(0, 300);
    await ref.update({ status: "failed", error: msg, finishedAt: now() }).catch(() => {});
    throw new Error(msg);
  }
}

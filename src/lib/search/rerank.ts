import { GoogleAuth } from "google-auth-library";
import type { Region } from "@/lib/types/tenant";
import { isSearchRerankEnabled } from "./flags";

/**
 * Reorder search results with Google's Ranking API (Vertex AI Search). It runs only in the
 * `global` and `us` locations, so only US brands are reranked: an EU or Asia brand's text never
 * leaves its region. Needs the Discovery Engine API and the discoveryengine.rankingConfigs.rank
 * permission for the runtime service account. Any failure keeps the merged order.
 */

export const RANK_MODEL = "semantic-ranker-default@latest";
/** Most records sent to one rank call (the API takes up to 1,000). */
export const RANK_MAX_RECORDS = 40;

let _auth: GoogleAuth | null = null;
function auth(): GoogleAuth {
  if (!_auth) _auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  return _auth;
}

export function canRerank(region: Region): boolean {
  const project = process.env.GOOGLE_CLOUD_PROJECT?.trim();
  return isSearchRerankEnabled() && region === "us" && Boolean(project && !project.startsWith("demo-"));
}

export interface RankRecord {
  id: string;
  title: string;
  content: string;
}

/** The ids in the Ranking API's order, or null (off, not a US brand, or it failed). */
export async function rerank(
  query: string,
  records: RankRecord[],
  region: Region,
  deps: { fetch?: typeof fetch; token?: () => Promise<string | null | undefined> } = {},
): Promise<string[] | null> {
  if (!canRerank(region) || records.length < 2) return null;
  const project = process.env.GOOGLE_CLOUD_PROJECT as string;
  try {
    const token = await (deps.token ?? (() => auth().getAccessToken()))();
    if (!token) return null;
    const res = await (deps.fetch ?? fetch)(`https://us-discoveryengine.googleapis.com/v1/projects/${project}/locations/us/rankingConfigs/default_ranking_config:rank`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Goog-User-Project": project },
      body: JSON.stringify({
        model: RANK_MODEL,
        query: query.slice(0, 500),
        records: records.slice(0, RANK_MAX_RECORDS).map((r) => ({ id: r.id, title: r.title.slice(0, 300), content: r.content.slice(0, 2000) })),
        ignoreRecordDetailsInResponse: true,
      }),
    });
    if (!res.ok) {
      console.warn(`[search] rerank failed: ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { records?: Array<{ id?: string }> };
    const ids = (body.records ?? []).map((r) => r.id).filter((id): id is string => typeof id === "string");
    return ids.length ? ids : null;
  } catch (err) {
    console.warn("[search] rerank failed:", err instanceof Error ? err.message.slice(0, 200) : "error");
    return null;
  }
}

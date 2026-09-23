import { z } from "zod";
import type { ProductMap } from "@/lib/connect/productMapSchema";

/**
 * "Learn from your repo" runs (regional `repo_analyses`). The app creates one
 * (queued), the knowledge-scraper Job fills in the product map, a person reviews
 * it and accepts chosen items into the connection's catalog. Repos are read
 * only; the doc holds the map and short redacted evidence — never source code.
 */

export const RepoAnalysisStatus = z.enum(["queued", "running", "done", "incomplete", "failed"]);
export type RepoAnalysisStatus = z.infer<typeof RepoAnalysisStatus>;

export interface AnalysisRepo {
  provider: "github" | "gitlab";
  url: string;
  ref: string | null;
  /** Short name, used as a path prefix when several repos are analysed. */
  label: string;
}

export interface RepoAnalysisStats {
  files: number;
  turns: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  submitted: boolean;
  dropped: number;
  items: number;
  verifiedItems: number;
  evidence: number;
  verifiedEvidence: number;
}

export interface RepoAnalysis {
  id: string;
  tenantId: string;
  connectionId: string;
  productName: string;
  repos: AnalysisRepo[];
  status: RepoAnalysisStatus;
  /** Written by the Job; re-validated by the app before use. */
  map?: ProductMap | null;
  stats?: RepoAnalysisStats | null;
  error?: string | null;
  createdAt: string;
  createdBy: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  acceptedAt?: string | null;
  acceptedBy?: string | null;
  accepted?: { steps: number; events: number; traits: number; facts: number; glossary: number } | null;
}

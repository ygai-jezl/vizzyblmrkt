import { JobsClient } from "@google-cloud/run";
import type { Region } from "@/lib/types/tenant";
import type { KnowledgeChunkSource } from "@/lib/types/knowledgeBase";

/**
 * Trigger the containerised knowledge-scraper Cloud Run Job, passing the ticket
 * coordinates as a per-execution override (so one job image serves every
 * ingestion). Uses ADC — the App Hosting runtime SA needs the IAM permission
 * `run.jobs.runWithOverrides` on the job. Region in the resource name is where
 * the JOB is deployed (KNOWLEDGE_JOB_LOCATION), not the tenant's data region.
 */

let _client: JobsClient | null = null;
function client(): JobsClient {
  if (!_client) _client = new JobsClient();
  return _client;
}

export interface IngestionJobVars {
  ticketId: string;
  tenantId: string;
  campaignId: string;
  region: Region;
  source: KnowledgeChunkSource;
  sourceUri: string;
  ref?: string | null;
  /** Optional path globs to scope a repo ingest (repos only). */
  includeGlobs?: string[] | null;
}

export function isIngestionJobConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLOUD_PROJECT && process.env.KNOWLEDGE_JOB_NAME);
}

/** Fully-qualified Cloud Run Job resource name. Throws if unconfigured. */
export function ingestionJobResourceName(): string {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  const job = process.env.KNOWLEDGE_JOB_NAME;
  const location = process.env.KNOWLEDGE_JOB_LOCATION ?? "us-central1";
  if (!project || !job) throw new Error("ingestion_job_not_configured");
  return `projects/${project}/locations/${location}/jobs/${job}`;
}

/** Build the runJob request (pure — unit-tested without the GCP client). */
export function buildRunJobRequest(vars: IngestionJobVars): {
  name: string;
  overrides: {
    containerOverrides: Array<{ env: Array<{ name: string; value: string }> }>;
  };
} {
  const env = [
    { name: "TICKET_ID", value: vars.ticketId },
    { name: "TENANT_ID", value: vars.tenantId },
    { name: "CAMPAIGN_ID", value: vars.campaignId },
    { name: "REGION", value: vars.region },
    { name: "INGEST_SOURCE", value: vars.source },
    { name: "SOURCE_URI", value: vars.sourceUri },
  ];
  if (vars.ref) env.push({ name: "INGEST_REF", value: vars.ref });
  if (vars.includeGlobs && vars.includeGlobs.length > 0) {
    env.push({ name: "INCLUDE_GLOBS", value: JSON.stringify(vars.includeGlobs) });
  }
  return {
    name: ingestionJobResourceName(),
    overrides: { containerOverrides: [{ env }] },
  };
}

/** Minimal seam so tests can inject a fake runner without the GCP client. */
export interface JobRunner {
  runJob(request: ReturnType<typeof buildRunJobRequest>): Promise<unknown>;
}

/** Kick off one ingestion execution. Throws on misconfiguration / API error. */
export async function triggerIngestionJob(
  vars: IngestionJobVars,
  runner?: JobRunner,
): Promise<void> {
  const request = buildRunJobRequest(vars);
  const c = runner ?? (client() as unknown as JobRunner);
  await c.runJob(request);
}

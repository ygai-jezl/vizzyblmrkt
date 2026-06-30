import { JobsClient } from "@google-cloud/run";
import type { Region } from "@/lib/types/tenant";
import type {
  KnowledgeChunkSource,
  KnowledgeOwnerKind,
} from "@/lib/types/knowledgeBase";

/**
 * Trigger the containerised knowledge-scraper Cloud Run Job, passing the ticket
 * coordinates as a per-execution override. Uses ADC — the App Hosting runtime SA
 * needs `run.jobs.runWithOverrides` on the job. Region in the resource name is
 * where the JOB is deployed (KNOWLEDGE_JOB_LOCATION), not the data region.
 */

let _client: JobsClient | null = null;
function client(): JobsClient {
  if (!_client) _client = new JobsClient();
  return _client;
}

export interface IngestionJobVars {
  ticketId: string;
  tenantId: string;
  ownerKind: KnowledgeOwnerKind;
  ownerId: string;
  region: Region;
  source: KnowledgeChunkSource;
  sourceUri: string;
  ref?: string | null;
  includeGlobs?: string[] | null;
  topic: string;
  tags: string[];
}

export function isIngestionJobConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLOUD_PROJECT && process.env.KNOWLEDGE_JOB_NAME);
}

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
    { name: "OWNER_KIND", value: vars.ownerKind },
    { name: "OWNER_ID", value: vars.ownerId },
    { name: "REGION", value: vars.region },
    { name: "INGEST_SOURCE", value: vars.source },
    { name: "SOURCE_URI", value: vars.sourceUri },
    { name: "TOPIC", value: vars.topic },
  ];
  if (vars.ref) env.push({ name: "INGEST_REF", value: vars.ref });
  if (vars.includeGlobs && vars.includeGlobs.length > 0) {
    env.push({ name: "INCLUDE_GLOBS", value: JSON.stringify(vars.includeGlobs) });
  }
  if (vars.tags && vars.tags.length > 0) {
    env.push({ name: "TAGS", value: JSON.stringify(vars.tags) });
  }
  return {
    name: ingestionJobResourceName(),
    overrides: { containerOverrides: [{ env }] },
  };
}

export interface JobRunner {
  runJob(request: ReturnType<typeof buildRunJobRequest>): Promise<unknown>;
}

export async function triggerIngestionJob(
  vars: IngestionJobVars,
  runner?: JobRunner,
): Promise<void> {
  const request = buildRunJobRequest(vars);
  const c = runner ?? (client() as unknown as JobRunner);
  await c.runJob(request);
}

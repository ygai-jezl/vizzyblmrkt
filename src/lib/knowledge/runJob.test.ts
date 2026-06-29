import { describe, it, expect, afterEach, vi } from "vitest";
import {
  buildRunJobRequest,
  ingestionJobResourceName,
  isIngestionJobConfigured,
  triggerIngestionJob,
  type IngestionJobVars,
} from "./runJob";

const vars: IngestionJobVars = {
  ticketId: "tkt_1",
  tenantId: "ten_A",
  campaignId: "camp1",
  region: "eu",
  source: "github",
  sourceUri: "https://github.com/org/repo",
  ref: "main",
};

afterEach(() => vi.unstubAllEnvs());

describe("runJob configuration", () => {
  it("isIngestionJobConfigured needs both project and job name", () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "proj");
    vi.stubEnv("KNOWLEDGE_JOB_NAME", "");
    expect(isIngestionJobConfigured()).toBe(false);
    vi.stubEnv("KNOWLEDGE_JOB_NAME", "knowledge-scraper");
    expect(isIngestionJobConfigured()).toBe(true);
  });

  it("builds the resource name from project + location + name", () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "proj");
    vi.stubEnv("KNOWLEDGE_JOB_NAME", "knowledge-scraper");
    vi.stubEnv("KNOWLEDGE_JOB_LOCATION", "us-central1");
    expect(ingestionJobResourceName()).toBe(
      "projects/proj/locations/us-central1/jobs/knowledge-scraper",
    );
  });
});

describe("buildRunJobRequest", () => {
  it("packs all ticket coordinates into containerOverrides env", () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "proj");
    vi.stubEnv("KNOWLEDGE_JOB_NAME", "knowledge-scraper");
    const req = buildRunJobRequest(vars);
    const env = req.overrides.containerOverrides[0]!.env;
    const get = (n: string) => env.find((e) => e.name === n)?.value;
    expect(get("TICKET_ID")).toBe("tkt_1");
    expect(get("TENANT_ID")).toBe("ten_A");
    expect(get("CAMPAIGN_ID")).toBe("camp1");
    expect(get("REGION")).toBe("eu");
    expect(get("INGEST_SOURCE")).toBe("github");
    expect(get("SOURCE_URI")).toBe("https://github.com/org/repo");
    expect(get("INGEST_REF")).toBe("main");
  });

  it("omits INGEST_REF when no ref is given", () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "proj");
    vi.stubEnv("KNOWLEDGE_JOB_NAME", "knowledge-scraper");
    const req = buildRunJobRequest({ ...vars, ref: null });
    expect(req.overrides.containerOverrides[0]!.env.some((e) => e.name === "INGEST_REF")).toBe(false);
  });

  it("emits INCLUDE_GLOBS as JSON when globs are provided, omits it otherwise", () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "proj");
    vi.stubEnv("KNOWLEDGE_JOB_NAME", "knowledge-scraper");
    const withGlobs = buildRunJobRequest({ ...vars, includeGlobs: ["src/**", "docs/*.md"] });
    const glob = withGlobs.overrides.containerOverrides[0]!.env.find((e) => e.name === "INCLUDE_GLOBS");
    expect(glob).toBeTruthy();
    expect(JSON.parse(glob!.value)).toEqual(["src/**", "docs/*.md"]);

    const none = buildRunJobRequest({ ...vars, includeGlobs: null });
    expect(none.overrides.containerOverrides[0]!.env.some((e) => e.name === "INCLUDE_GLOBS")).toBe(false);
  });
});

describe("triggerIngestionJob", () => {
  it("calls the injected runner with the built request", async () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "proj");
    vi.stubEnv("KNOWLEDGE_JOB_NAME", "knowledge-scraper");
    const runJob = vi.fn().mockResolvedValue([{}]);
    await triggerIngestionJob(vars, { runJob });
    expect(runJob).toHaveBeenCalledTimes(1);
    expect(runJob.mock.calls[0]![0].name).toContain("/jobs/knowledge-scraper");
  });
});

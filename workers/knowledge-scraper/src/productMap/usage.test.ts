import { describe, it, expect } from "vitest";
import { FieldValue } from "firebase-admin/firestore";
import { GENERAL_PASS, type ModelClient } from "./analyst";
import { readProductMapEnv, runProductMap } from "./run";
import { countingModel } from "./usage";

/** A model that submits at once. Each call reports 1,000 tokens in, 100 out and 1,300 billed. */
function submitting(opts: { name?: string; failAfter?: number } = {}): ModelClient & { calls: number } {
  const m = {
    calls: 0,
    name: opts.name,
    async generate() {
      m.calls += 1;
      if (opts.failAfter !== undefined && m.calls > opts.failAfter) throw new Error("model_call_failed:500");
      return {
        parts: [{ functionCall: { name: "submit_product_map", args: { summary: "Acme." } } }],
        usage: { input: 1000, output: 100, total: 1300 },
      };
    },
  };
  return m;
}

/** The analysis doc plus every write to `usage_meters`. */
function fakeDb() {
  const analysis = { data: { tenantId: "ten_A", status: "queued", repos: [{ provider: "github", url: "https://github.com/acme/web", ref: "main", label: "web" }] } as Record<string, unknown> };
  const meterWrites: { collection: string; id: string; data: Record<string, unknown>; opts: unknown }[] = [];
  const db = {
    collection: (name: string) => ({
      doc: (id: string) =>
        name === "usage_meters"
          ? {
              async set(data: Record<string, unknown>, opts: unknown) {
                meterWrites.push({ collection: name, id, data, opts });
              },
            }
          : {
              async get() {
                return { exists: true, data: () => analysis.data };
              },
              async update(p: Record<string, unknown>) {
                analysis.data = { ...analysis.data, ...p };
              },
            },
    }),
  } as never;
  return { db, analysis, meterWrites };
}

const env = { analysisId: "ra_1", tenantId: "ten_A", region: "us" as const, project: "p" };
const deps = {
  token: async () => "tok",
  collect: async () => ({ files: [{ path: "src/app.ts", text: "export const a = 1;\n", isCode: true, lang: "ts" }], filesProcessed: 1 }),
  now: () => "2026-11-23T10:00:00Z",
  passes: [GENERAL_PASS],
};

describe("product map model use on the usage meter", () => {
  it("reads the switch from the run's settings", () => {
    const base = { ANALYSIS_ID: "ra_1", TENANT_ID: "ten_A", REGION: "eu", GOOGLE_CLOUD_PROJECT: "p" };
    expect(readProductMapEnv({ ...base, USAGE_METER_ENABLED: "true" }).usageMeter).toBe(true);
    expect(readProductMapEnv(base).usageMeter).toBe(false);
    expect(readProductMapEnv({ ...base, USAGE_METER_ENABLED: "1" }).usageMeter).toBe(false);
  });

  it("counts billed tokens, falls back to in plus out, and counts a failed call as lost", async () => {
    const plain: ModelClient = { async generate() { return { parts: [], usage: { input: 10, output: 5 } }; } };
    const { model, spend } = countingModel(plain);
    await model.generate({ system: "", contents: [], tools: [] });
    expect(spend).toEqual({ tokens: 15, calls: 1, lostCalls: 0 });

    const failing = countingModel(submitting({ failAfter: 1 }));
    await failing.model.generate({ system: "", contents: [], tools: [] });
    await expect(failing.model.generate({ system: "", contents: [], tools: [] })).rejects.toThrow();
    expect(failing.spend).toEqual({ tokens: 1300, calls: 2, lostCalls: 1 });
  });

  it("adds the run's tokens to this month's meter in one merged write, the model id as a map key", async () => {
    const { db, analysis, meterWrites } = fakeDb();
    const model = submitting({ name: "gemini-3.8-flash" });
    await runProductMap({ ...env, usageMeter: true }, { ...deps, db, model });
    expect(analysis.data.status).toBe("done");
    expect(meterWrites).toHaveLength(1);
    const w = meterWrites[0]!;
    expect(w.id).toBe("um_ten_A_2026-11");
    expect(w.opts).toEqual({ merge: true });
    const tokens = 1300 * model.calls;
    expect(w.data).toEqual({
      tenantId: "ten_A",
      month: "2026-11",
      updatedAt: "2026-11-23T10:00:00.000Z",
      meters: {
        model_tokens: {
          total: FieldValue.increment(tokens),
          calls: FieldValue.increment(model.calls),
          lostCalls: FieldValue.increment(0),
          byPurpose: { product_map: FieldValue.increment(tokens) },
          byModel: { "gemini-3.8-flash": FieldValue.increment(tokens) },
        },
      },
    });
  });

  it("still records what a failed run spent", async () => {
    const { db, analysis, meterWrites } = fakeDb();
    await expect(runProductMap({ ...env, usageMeter: true }, { ...deps, db, model: submitting({ name: "m", failAfter: 0 }) })).rejects.toThrow();
    expect(analysis.data.status).toBe("failed");
    expect(meterWrites).toHaveLength(1);
    expect((meterWrites[0]!.data.meters as Record<string, Record<string, unknown>>).model_tokens!.lostCalls).toEqual(FieldValue.increment(1));
  });

  it("writes nothing when the app didn't turn the meter on", async () => {
    const { db, analysis, meterWrites } = fakeDb();
    await runProductMap(env, { ...deps, db, model: submitting() });
    expect(analysis.data.status).toBe("done");
    expect(meterWrites).toHaveLength(0);
  });
});

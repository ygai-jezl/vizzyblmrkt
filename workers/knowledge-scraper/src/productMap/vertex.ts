import { GoogleAuth } from "google-auth-library";
import type { Content, FunctionDecl, ModelClient, ModelTurn, Part } from "./analyst";
import type { Region } from "../config";

/**
 * Gemini on Vertex AI (REST generateContent with function calling). Auth is the
 * Job's runtime service account (ADC) — no API key.
 *
 * LOCATION: defaults to Vertex's `global` endpoint, like every other Gemini call
 * on the platform (the current models are served there). Google's guidance:
 * global gives NO data-residency guarantee for ML processing. To keep a region's
 * tenants' code processed in-region, pin that region with
 * PRODUCT_MAP_LOCATION_{US,EU,ASIA} (e.g. "europe-west4", or a jurisdictional
 * multi-region "eu" / "us") and, if needed, PRODUCT_MAP_MODEL_{US,EU,ASIA} for a
 * model that's served there.
 */

const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });

/** Mirrors the app's DEFAULT_TEXT_MODEL (src/lib/agents/modelConfig.ts); env-overridable. */
export const DEFAULT_PRODUCT_MAP_MODEL = "gemini-3.6-flash";

const REGION_KEY: Record<Region, string> = { us: "US", eu: "EU", asia: "ASIA" };

export function modelLocation(region: Region, env: NodeJS.ProcessEnv = process.env): string {
  if (!REGION_KEY[region]) throw new Error(`no model location for region '${region}'`);
  return env[`PRODUCT_MAP_LOCATION_${REGION_KEY[region]}`] ?? env.PRODUCT_MAP_LOCATION ?? "global";
}

export function modelFor(region: Region, env: NodeJS.ProcessEnv = process.env): string {
  return env[`PRODUCT_MAP_MODEL_${REGION_KEY[region]}`] ?? env.PRODUCT_MAP_MODEL ?? DEFAULT_PRODUCT_MAP_MODEL;
}

/** The generateContent URL for a location: global, a jurisdiction (us/eu) or a region. */
export function endpointUrl(project: string, location: string, model: string): string {
  const host =
    location === "global"
      ? "aiplatform.googleapis.com"
      : location === "us" || location === "eu"
        ? `aiplatform.${location}.rep.googleapis.com`
        : `${location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;
}

export function vertexModel(opts: { project: string; region: Region; model?: string; timeoutMs?: number }): ModelClient {
  const model = opts.model ?? modelFor(opts.region);
  const url = endpointUrl(opts.project, modelLocation(opts.region), model);
  return {
    async generate(req: { system: string; contents: Content[]; tools: FunctionDecl[]; forceTool?: string; json?: boolean }): Promise<ModelTurn> {
      const client = await auth.getClient();
      const body = {
        systemInstruction: { parts: [{ text: req.system }] },
        contents: req.contents,
        ...(req.tools.length
          ? {
              tools: [{ functionDeclarations: req.tools }],
              toolConfig: {
                functionCallingConfig: req.forceTool ? { mode: "ANY", allowedFunctionNames: [req.forceTool] } : { mode: "AUTO" },
              },
            }
          : {}),
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 16_384,
          ...(req.json ? { responseMimeType: "application/json" } : {}),
        },
      };
      let lastErr: unknown = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const res = await client.request<{
            candidates?: { content?: { parts?: Part[] } }[];
            usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
          }>({ url, method: "POST", data: body, timeout: opts.timeoutMs ?? 120_000 });
          return {
            parts: res.data.candidates?.[0]?.content?.parts ?? [],
            usage: { input: res.data.usageMetadata?.promptTokenCount ?? 0, output: res.data.usageMetadata?.candidatesTokenCount ?? 0 },
          };
        } catch (err) {
          lastErr = err;
          const status = (err as { response?: { status?: number } }).response?.status;
          if (status && status !== 429 && status < 500) break; // not retryable
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1) ** 2));
        }
      }
      const resp = (lastErr as { response?: { status?: number; data?: { error?: { message?: string } } } })?.response;
      // Vertex's message describes the request (never our credentials or the customer's code).
      const why = resp?.data?.error?.message?.replace(/\s+/g, " ").slice(0, 160);
      throw new Error(`model_call_failed${resp?.status ? `:${resp.status}` : ""}${why ? ` ${why}` : ""}`);
    },
  };
}

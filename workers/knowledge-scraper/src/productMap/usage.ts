import type { Firestore } from "firebase-admin/firestore";
import { FieldValue } from "../firestore";
import type { ModelClient } from "./analyst";

/**
 * The app's usage meter (src/lib/plans/meter.ts): a repo analysis adds the model tokens it spent
 * to the brand's `usage_meters/um_<tenantId>_<YYYY-MM>` doc, as AI model use by "product_map".
 * Only when the app passed USAGE_METER_ENABLED=true with the run, so an app without the meter
 * sees nothing new. The doc shape must match `UsageMeterDoc` (src/lib/types/usageMeter.ts).
 */
export const USAGE_METERS = "usage_meters";
const PURPOSE = "product_map";

export interface ModelSpend {
  tokens: number;
  calls: number;
  /** Calls that failed after they may have spent tokens. */
  lostCalls: number;
}

/** Wrap a model so every call it makes is counted, including calls in a run that fails later. */
export function countingModel(model: ModelClient): { model: ModelClient; spend: ModelSpend } {
  const spend: ModelSpend = { tokens: 0, calls: 0, lostCalls: 0 };
  return {
    spend,
    model: {
      name: model.name,
      async generate(req) {
        try {
          const turn = await model.generate(req);
          spend.tokens += turn.usage.total ?? turn.usage.input + turn.usage.output;
          spend.calls += 1;
          return turn;
        } catch (err) {
          spend.calls += 1;
          spend.lostCalls += 1;
          throw err;
        }
      },
    },
  };
}

/**
 * Add one run's spend to the brand's meter in one atomic write: increments on nested maps
 * (a model id like "gemini-3.8-flash" has dots, so it is a map key, never an update path).
 * A failed write never fails the run.
 */
export async function recordModelSpend(
  db: Firestore,
  o: { tenantId: string; model: string; spend: ModelSpend; now: Date },
): Promise<void> {
  const { spend } = o;
  if (spend.calls === 0) return;
  const inc = (n: number) => FieldValue.increment(n);
  const month = o.now.toISOString().slice(0, 7);
  const model = o.model.trim().slice(0, 80) || "unknown";
  try {
    await db
      .collection(USAGE_METERS)
      .doc(`um_${o.tenantId}_${month}`)
      .set(
        {
          tenantId: o.tenantId,
          month,
          updatedAt: o.now.toISOString(),
          meters: {
            model_tokens: {
              total: inc(spend.tokens),
              calls: inc(spend.calls),
              lostCalls: inc(spend.lostCalls),
              byPurpose: { [PURPOSE]: inc(spend.tokens) },
              byModel: { [model]: inc(spend.tokens) },
            },
          },
        },
        { merge: true },
      );
    console.info(`[usage] ${o.tenantId} model_tokens ${PURPOSE} ${spend.tokens} ${model}`);
  } catch (err) {
    console.warn(`[usage] ${o.tenantId} model_tokens record failed:`, err instanceof Error ? err.message.slice(0, 200) : "error");
  }
}

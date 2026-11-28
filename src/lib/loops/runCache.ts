import type { TenantContext } from "@/lib/tenant/types";
import type { Made } from "@/lib/types/loopStamp";
import { isImageKind } from "./imageKinds";
import { learnedFor, type LearnedForDeps, type LearnedForOptions } from "./read";
import type { LoopKind } from "./registry";

/**
 * A batch run's stamps (learning loops step 5, 4.1 of the plan for steps 4 and 5): a sender that
 * sends hundreds of emails in a run reads what was learned once per brand and kind, not once per
 * email. Only for kinds that aren't image kinds: an image's stamp depends on its own id (the
 * holdback), so it is never shared. Holds one small stamp per brand and kind, for one run only.
 */
export class RunCache {
  private readonly stamps = new Map<string, Promise<Made>>();

  constructor(private readonly deps: LearnedForDeps = {}) {}

  /** The stamp for this brand and kind in this run, read once. */
  stamp(ctx: TenantContext, kind: LoopKind, opts: Pick<LearnedForOptions, "scope" | "promptId" | "by"> = {}): Promise<Made> {
    if (isImageKind(kind)) throw new Error("RunCache is not for image kinds: each image has its own stamp");
    const key = [ctx.tenantId, kind, opts.scope ?? "", opts.promptId ?? "", opts.by ?? ""].join("|");
    let p = this.stamps.get(key);
    if (!p) {
      // No read for these kinds (learnedFor), so this is quick and can't fail on the database.
      p = learnedFor(ctx, kind, opts, this.deps).then((r) => r.stamp);
      this.stamps.set(key, p);
    }
    return p;
  }
}

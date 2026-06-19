import { TenantCollection, TenantIsolationError } from "@/lib/tenant";
import type { Campaign } from "@/lib/types/campaign";
import { CampaignIdSchema, suffixedCampaignId } from "./campaignSettings";

/** The campaign shape a caller supplies to create() — tenantId/id are stamped. */
export type NewLaunch = Omit<Campaign, "id" | "tenantId">;

/**
 * Backstop on the suffix search. A tenant hitting dozens of `early-access-N`
 * collisions is pathological, not expected; we cap the loop so a runaway can
 * never spin, and surface the last id we tried as taken.
 */
const MAX_SUFFIX_ATTEMPTS = 50;

/**
 * Raised when a launch cannot be created under the requested id. For an explicit
 * (user-typed) slug this means "that exact slug is taken"; for a derived slug it
 * means even the suffixed candidates were exhausted. Routes map it to HTTP 409.
 */
export class LaunchIdTakenError extends Error {
  constructor(public readonly id: string) {
    super(`A launch with id "${id}" already exists.`);
    this.name = "LaunchIdTakenError";
  }
}

/**
 * Atomically create a launch, resolving slug collisions.
 *
 * Campaign ids are the public `/waitlist/<id>` slug and double as the Firestore
 * document id, which is unique across ALL tenants in a region (see
 * TenantCollection.create). Two brands picking the same launch name therefore
 * derive the same slug and would collide. We resolve that based on intent:
 *
 *  - DERIVED id (auto-generated from the launch name): append `-2`, `-3`, … until
 *    a free slug is found, so one brand never blocks another's launch name.
 *  - EXPLICIT id (typed by the user): honoured verbatim — a collision throws
 *    LaunchIdTakenError rather than silently changing the slug they chose.
 *
 * Returns the id actually written.
 */
export async function createLaunch(
  campaigns: TenantCollection<Campaign>,
  baseId: string,
  data: NewLaunch,
  opts: { explicit: boolean },
): Promise<string> {
  const maxAttempts = opts.explicit ? 1 : MAX_SUFFIX_ATTEMPTS;
  let lastId = baseId;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    // attempt 0 → baseId; 1 → base-2; 2 → base-3; … (the -1 slot is the base).
    const candidate =
      attempt === 0 ? baseId : suffixedCampaignId(baseId, attempt + 1);

    // A suffix trims the base to stay within the length cap and can, in theory,
    // land on an invalid id; skip it and keep searching within the bounded loop.
    const valid = CampaignIdSchema.safeParse(candidate);
    if (!valid.success) continue;
    lastId = valid.data;

    try {
      await campaigns.create(valid.data, data);
      return valid.data;
    } catch (err) {
      // Slug taken → try the next suffix (or, when explicit, fall straight out
      // of the single-iteration loop and report the conflict below).
      if (err instanceof TenantIsolationError) continue;
      throw err;
    }
  }

  throw new LaunchIdTakenError(lastId);
}

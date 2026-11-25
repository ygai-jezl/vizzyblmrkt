import { describe, expect, it, vi } from "vitest";
import type { CreateAuthTokenParameters } from "@google/genai";
import { DEFAULT_ONBOARDING_LIVE_MODEL, ONBOARDING_LIVE_MODEL } from "@/lib/agents/modelConfig";
import { buildOnboardingLiveConfig } from "./config";
import { mintOnboardingVoiceToken, type LiveTokenMinter } from "./mint";

const NOW = Date.parse("2026-11-25T10:00:00.000Z");

/** The Live token client, faked: no call leaves the test. */
function minter(name: string | null = "auth_tokens/abc123") {
  const create = vi.fn(async (_: CreateAuthTokenParameters) => (name === null ? {} : { name }));
  return { live: { authTokens: { create } } as LiveTokenMinter, create };
}

describe("the Talk with Vizzy token", () => {
  it("is single use, a minute to connect, six minutes in all, on v1alpha", async () => {
    const { live, create } = minter();
    const config = buildOnboardingLiveConfig({ brandName: "Fernhill Plants" });
    const token = await mintOnboardingVoiceToken(live, config, NOW);
    expect(token).toEqual({ token: "auth_tokens/abc123", model: ONBOARDING_LIVE_MODEL, expiresAt: "2026-11-25T10:06:00.000Z" });
    expect(create).toHaveBeenCalledTimes(1);
    const sent = create.mock.calls[0]![0].config!;
    expect(sent.uses).toBe(1);
    expect(sent.expireTime).toBe("2026-11-25T10:06:00.000Z");
    expect(sent.newSessionExpireTime).toBe("2026-11-25T10:01:00.000Z");
    expect(sent.httpOptions).toEqual({ apiVersion: "v1alpha" });
  });

  it("locks the model and the whole config: nothing is left for the browser to set", async () => {
    const { live, create } = minter();
    const config = buildOnboardingLiveConfig({ brandName: "Fernhill Plants" });
    await mintOnboardingVoiceToken(live, config, NOW);
    const sent = create.mock.calls[0]![0].config!;
    expect(sent.liveConnectConstraints).toEqual({ model: ONBOARDING_LIVE_MODEL, config });
    expect(sent).not.toHaveProperty("lockAdditionalFields");
  });

  it("uses the onboarding model, gemini-3.8-live unless the deployment sets another", () => {
    expect(DEFAULT_ONBOARDING_LIVE_MODEL).toBe("gemini-3.8-live");
    if (!process.env.GEMINI_ONBOARDING_LIVE_MODEL) expect(ONBOARDING_LIVE_MODEL).toBe("gemini-3.8-live");
  });

  it("gives null when Google returns no token, and passes a failure on", async () => {
    const config = buildOnboardingLiveConfig({ brandName: "Fernhill Plants" });
    expect(await mintOnboardingVoiceToken(minter(null).live, config, NOW)).toBeNull();
    const failing = { authTokens: { create: vi.fn(async () => Promise.reject(new Error("quota"))) } } as LiveTokenMinter;
    await expect(mintOnboardingVoiceToken(failing, config, NOW)).rejects.toThrow("quota");
  });
});

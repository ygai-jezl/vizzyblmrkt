import type { AuthToken, CreateAuthTokenParameters, LiveConnectConfig } from "@google/genai";
import { ONBOARDING_LIVE_MODEL } from "@/lib/agents/modelConfig";
import { CONNECT_SECONDS, TOKEN_SECONDS } from "./config";

/**
 * The token a browser opens Talk with Vizzy with: a Gemini Developer API (AI Studio) ephemeral
 * token from getLiveTokenClient() (src/lib/agents/gemini.ts). A browser can't open a Vertex AI
 * Live session without a proxy of ours, and ephemeral tokens exist only on the Developer API.
 * This is the one place to change when the call moves.
 *
 * - One use; a minute to connect; six minutes in all, so the five minute call always ends first.
 * - The model and the whole config are locked (no lockAdditionalFields): the browser can't change
 *   the instruction, the voice or the tools.
 */

/** The part of the Live token client this needs. */
export interface LiveTokenMinter {
  authTokens: { create(params: CreateAuthTokenParameters): Promise<AuthToken> };
}

export interface MintedVoiceToken {
  token: string;
  model: string;
  /** When the token stops working (the call must be over by then). */
  expiresAt: string;
}

/** A token for one call, or null when Google gave none. Throws what the client throws. */
export async function mintOnboardingVoiceToken(
  live: LiveTokenMinter,
  config: LiveConnectConfig,
  now: number = Date.now(),
  model: string = ONBOARDING_LIVE_MODEL,
): Promise<MintedVoiceToken | null> {
  const expiresAt = new Date(now + TOKEN_SECONDS * 1000).toISOString();
  const token = await live.authTokens.create({
    config: {
      uses: 1,
      expireTime: expiresAt,
      newSessionExpireTime: new Date(now + CONNECT_SECONDS * 1000).toISOString(),
      liveConnectConstraints: { model, config },
      httpOptions: { apiVersion: "v1alpha" },
    },
  });
  return token.name ? { token: token.name, model, expiresAt } : null;
}

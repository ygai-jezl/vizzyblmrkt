import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mintGitHubAppToken } from "./gitToken";

const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();

describe("GitHub App tokens in the worker", () => {
  it("mints a read-only installation token", async () => {
    let body = "";
    const f = (async (_url: string, init?: RequestInit) => {
      body = String(init?.body);
      return new Response(JSON.stringify({ token: "ghs_x" }), { status: 201 });
    }) as unknown as typeof fetch;
    // PEMs are often stored with literal \n in env vars.
    const token = await mintGitHubAppToken(77, { GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: pem.replace(/\n/g, "\\n") }, f);
    expect(token).toBe("ghs_x");
    expect(JSON.parse(body)).toEqual({ permissions: { contents: "read", metadata: "read" } });
  });

  it("returns nothing (never throws a secret) when the Job isn't configured or GitHub refuses", async () => {
    expect(await mintGitHubAppToken(77, {})).toBeUndefined();
    const refuse = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    expect(await mintGitHubAppToken(77, { GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: pem }, refuse)).toBeUndefined();
  });
});

import { NextResponse } from "next/server";
import { z } from "zod";
import { isPasswordSigninAvailable } from "@/lib/auth/flags";
import { confirmEmailCode, requestEmailCode, type EmailCodeAnswer } from "@/lib/auth/emailCode";
import { clientIp } from "@/lib/http/clientIp";
import { readRequestTextCapped } from "@/lib/http/readBody";
import { sameOriginGuard } from "@/lib/http/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The emailed code that confirms a password account (src/lib/auth/emailCode.ts).
 *  - POST { idToken }        send a code: 200 { ok: true, resendAfter: 30 } whether or not the
 *                            address may get in, or 200 { ok: true, alreadyVerified: true }
 *  - PUT  { idToken, code }  check it: 200 { ok: true }, or 400 code_wrong (with attemptsLeft),
 *                            code_expired or code_too_many
 * Both: 403 from the same-origin check, 503 password_signin_disabled while password sign-in is
 * unavailable, 400 invalid_input, 401 invalid_id_token, 400 not_a_password_account,
 * 429 rate_limited.
 */

/** An ID token is a couple of kilobytes; nothing here needs more. */
const MAX_BODY_BYTES = 16_384;

const IdToken = z.string().min(1).max(10_000);
const SendBody = z.object({ idToken: IdToken });
const CheckBody = z.object({ idToken: IdToken, code: z.string().regex(/^\d{6}$/) });

async function parse<T>(req: Request, schema: z.ZodType<T>): Promise<T | null> {
  const text = await readRequestTextCapped(req, MAX_BODY_BYTES);
  if (text === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** The checks both methods start with; a response to send now, or null to go on. */
function gate(req: Request): NextResponse | null {
  const crossSite = sameOriginGuard(req);
  if (crossSite) return crossSite;
  if (!isPasswordSigninAvailable()) {
    return NextResponse.json({ error: "password_signin_disabled" }, { status: 503 });
  }
  return null;
}

async function answer(work: () => Promise<EmailCodeAnswer>): Promise<NextResponse> {
  try {
    const { status, body } = await work();
    return NextResponse.json(body, { status });
  } catch (err) {
    console.error("[auth-code] failed:", err instanceof Error ? err.message.slice(0, 200) : "error");
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}

/** Send a code to the signed-in password account's address. */
export async function POST(req: Request) {
  const stop = gate(req);
  if (stop) return stop;
  const body = await parse(req, SendBody);
  if (!body) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  return answer(() => requestEmailCode({ idToken: body.idToken, ip: clientIp(req.headers) }));
}

/** Check the code the account holder typed. */
export async function PUT(req: Request) {
  const stop = gate(req);
  if (stop) return stop;
  const body = await parse(req, CheckBody);
  if (!body) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  return answer(() => confirmEmailCode({ idToken: body.idToken, code: body.code, ip: clientIp(req.headers) }));
}

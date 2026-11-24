import { NextResponse } from "next/server";
import { z } from "zod";
import { isPasswordSigninAvailable } from "@/lib/auth/flags";
import {
  confirmEmailCode,
  confirmEmailLink,
  LINK_TOKEN_RE,
  requestEmailCode,
  requestEmailLink,
  type EmailCodeAnswer,
} from "@/lib/auth/emailCode";
import { clientIp } from "@/lib/http/clientIp";
import { readRequestTextCapped } from "@/lib/http/readBody";
import { sameOriginGuard } from "@/lib/http/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The emailed code, or link, that confirms a password account (src/lib/auth/emailCode.ts).
 *  - POST { idToken }               send a code: 200 { ok: true, resendAfter: 30 } whether or not
 *                                   the address may get in, or 200 { ok: true, alreadyVerified: true };
 *                                   429 code_locked once the address had 15 wrong codes in a day
 *  - POST { idToken, via: "link" }  send a link instead: 200 { ok: true, via: "link" } (or
 *                                   alreadyVerified), even while codes are locked; 503
 *                                   link_unavailable when this copy has no platform origin
 *  - PUT  { idToken, code }         check a code: 200 { ok: true }, or 400 code_wrong (with
 *                                   attemptsLeft), code_expired, code_too_many or code_locked
 *  - PUT  { idToken, link }         open a link: 200 { ok: true }, or 400 link_invalid
 * All: 403 from the same-origin check, 503 password_signin_disabled while password sign-in is
 * unavailable, 400 invalid_input, 401 invalid_id_token, 400 not_a_password_account,
 * 429 rate_limited.
 */

/** An ID token is a couple of kilobytes; nothing here needs more. */
const MAX_BODY_BYTES = 16_384;

const IdToken = z.string().min(1).max(10_000);
const SendBody = z.object({ idToken: IdToken, via: z.enum(["code", "link"]).optional() });
/** A code or a link, never both. */
const CheckBody = z.union([
  z.object({ idToken: IdToken, code: z.string().regex(/^\d{6}$/) }).strict(),
  z.object({ idToken: IdToken, link: z.string().regex(LINK_TOKEN_RE) }).strict(),
]);

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

/** Send a code, or a link, to the signed-in password account's address. */
export async function POST(req: Request) {
  const stop = gate(req);
  if (stop) return stop;
  const body = await parse(req, SendBody);
  if (!body) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const input = { idToken: body.idToken, ip: clientIp(req.headers) };
  return answer(() => (body.via === "link" ? requestEmailLink(input) : requestEmailCode(input)));
}

/** Check the code the account holder typed, or the link they opened. */
export async function PUT(req: Request) {
  const stop = gate(req);
  if (stop) return stop;
  const body = await parse(req, CheckBody);
  if (!body) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const ip = clientIp(req.headers);
  return answer(() =>
    "link" in body
      ? confirmEmailLink({ idToken: body.idToken, link: body.link, ip })
      : confirmEmailCode({ idToken: body.idToken, code: body.code, ip }),
  );
}

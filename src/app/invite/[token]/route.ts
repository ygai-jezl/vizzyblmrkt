import { clientIp } from "@/lib/analytics/viewIngest";
import { escapeHtml } from "@/lib/email/emailRender";
import { handleInviteClick, type InviteClickResult } from "@/lib/invites/click";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Invite links from "Invite your waitlist" emails (nav v2 phase 4). Verifies the
 * signed token, records the click and sends the person to the product's sign-up
 * page with `yg_invite=<code>`. See src/lib/invites/click.ts.
 */

const HEADERS = {
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex",
};

function toResponse(r: InviteClickResult): Response {
  if (r.kind === "redirect") {
    return new Response(null, { status: 302, headers: { ...HEADERS, Location: r.location } });
  }
  const link = r.productUrl
    ? `<p><a href="${escapeHtml(r.productUrl)}" rel="noopener noreferrer">Go to sign-up</a></p>`
    : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(r.title)}</title></head>
<body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:48px 16px;color:#111;background:#fff">
<h1 style="font-size:20px">${escapeHtml(r.title)}</h1><p style="color:#444">${escapeHtml(r.message)}</p>${link}
</body></html>`;
  return new Response(html, { status: r.status, headers: { ...HEADERS, "Content-Type": "text/html; charset=utf-8" } });
}

type Ctx = { params: Promise<{ token: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const { token } = await params;
  return toResponse(await handleInviteClick(token, { method: "GET", ip: clientIp(req.headers) }));
}

export async function HEAD(req: Request, { params }: Ctx) {
  const { token } = await params;
  const res = toResponse(await handleInviteClick(token, { method: "HEAD", ip: clientIp(req.headers) }));
  return new Response(null, { status: res.status, headers: res.headers });
}

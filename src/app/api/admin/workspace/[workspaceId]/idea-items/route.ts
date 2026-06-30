import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import {
  verifyWorkspace,
  createIdeaItem,
  listIdeaItems,
  type CreateIdeaInput,
} from "@/lib/tenant/workspaceContent";
import { classifyLinkSource } from "@/lib/content/linkSource";
import {
  storeWorkspaceImage,
  isAllowedScreenshotType,
  MAX_SCREENSHOT_BYTES,
} from "@/lib/workspace/assetStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function field(v: FormDataEntryValue | null | undefined): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function firstLine(s: string): string {
  return s.split(/\n/).map((l) => l.trim()).find(Boolean) ?? "";
}

/** List a workspace's Idea Board captures. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { workspaceId } = await params;
  if (!(await verifyWorkspace(ctx, workspaceId))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const items = await listIdeaItems(ctx, workspaceId);
  return NextResponse.json({ items });
}

/** Capture a new idea (JSON {title?,note?,url?,text?} OR multipart with a screenshot file). */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { workspaceId } = await params;
  if (!(await verifyWorkspace(ctx, workspaceId))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  let title: string | undefined;
  let note: string | undefined;
  let url: string | undefined;
  let text: string | undefined;
  let screenshotPath: string | null = null;

  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData().catch(() => null);
    if (!form) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
    title = field(form.get("title"));
    note = field(form.get("note"));
    url = field(form.get("url"));
    text = field(form.get("text"));
    const file = form.get("file");
    if (file && file instanceof File && file.size > 0) {
      if (file.size > MAX_SCREENSHOT_BYTES) {
        return NextResponse.json({ error: "too_large" }, { status: 413 });
      }
      if (!isAllowedScreenshotType(file.type)) {
        return NextResponse.json({ error: "bad_type" }, { status: 400 });
      }
      const bytes = Buffer.from(await file.arrayBuffer());
      const stored = await storeWorkspaceImage(ctx.tenantId, workspaceId, bytes, file.type);
      if (!stored.ok) {
        return NextResponse.json({ error: "upload_failed", reason: stored.reason }, { status: 502 });
      }
      screenshotPath = stored.filename;
    }
  } else {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    title = field(typeof body.title === "string" ? body.title : undefined);
    note = field(typeof body.note === "string" ? body.note : undefined);
    url = field(typeof body.url === "string" ? body.url : undefined);
    text = field(typeof body.text === "string" ? body.text : undefined);
  }

  let sourceHost: string | null = null;
  let fetchable: boolean | null = null;
  if (url) {
    if (url.length > 2000) return NextResponse.json({ error: "invalid_url" }, { status: 400 });
    const cls = classifyLinkSource(url);
    if (!cls.host) return NextResponse.json({ error: "invalid_url" }, { status: 400 });
    sourceHost = cls.host;
    fetchable = cls.fetchable;
  }

  if (!url && !text && !screenshotPath) {
    return NextResponse.json({ error: "empty_idea" }, { status: 400 });
  }

  const derivedTitle = (
    title ||
    (text ? firstLine(text) : "") ||
    (sourceHost ? `Link: ${sourceHost}` : "") ||
    "Captured idea"
  ).slice(0, 200);

  const input: CreateIdeaInput = {
    title: derivedTitle,
    note: note ?? null,
    url: url ?? null,
    text: text ? text.slice(0, 20000) : null,
    screenshotPath,
    sourceHost,
    fetchable,
    status: "captured",
    templateId: null,
  };

  try {
    const item = await createIdeaItem(ctx, workspaceId, input);
    return NextResponse.json({ item });
  } catch {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
}

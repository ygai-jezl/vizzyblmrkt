import { NextResponse } from "next/server";
import { voiceChatAdmin } from "@/lib/audience/admin";
import { loadVoiceChat } from "@/lib/audience/voiceChat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read the conversation: one of a person's voice chats on a sign-up page, in full
 * (`?signup=<signupId>`). Admins only, as export is: it holds what they said in their own words.
 * There only while the Fields panel or the timeline, which link to it, is on.
 */
export async function GET(req: Request, { params }: { params: Promise<{ personId: string }> }) {
  const gate = await voiceChatAdmin(req);
  if (!gate.ok) return gate.response;
  const { personId } = await params;
  const signupId = new URL(req.url).searchParams.get("signup") ?? "";
  const chat = await loadVoiceChat(gate.ctx, personId, signupId);
  if (!chat) return NextResponse.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "no-store" } });
  return NextResponse.json({ chat }, { headers: { "cache-control": "no-store" } });
}

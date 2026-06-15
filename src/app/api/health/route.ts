import { NextResponse } from "next/server";

// Lightweight liveness probe. Intentionally touches no tenant data and no
// Firestore — it must stay fast and dependency-free so health checks never
// incur cost or cross a tenant boundary.
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    status: "ok",
    service: "vizzybl-marketing",
    phase: "0",
    time: new Date().toISOString(),
  });
}

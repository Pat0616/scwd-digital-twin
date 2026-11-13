import { NextResponse } from "next/server";
import { liveStatus } from "@/lib/status/live";
import { CACHE_MS } from "@/lib/twin/source";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The map's live status from the digital twin, keyed by twin id (the map itself listens to /api/status/stream). */
export async function GET() {
  try {
    const { body } = await liveStatus();
    return NextResponse.json(body, {
      headers: { "Cache-Control": `private, max-age=${Math.floor(CACHE_MS / 1000)}` },
    });
  } catch (err) {
    // the details stay in the server log: no credentials or twin data in the response
    console.error("GET /api/status:", err);
    return NextResponse.json({ error: "Could not read the digital twin" }, { status: 502 });
  }
}

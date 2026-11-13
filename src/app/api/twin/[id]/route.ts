import { NextResponse } from "next/server";
import { TwinIndex } from "@/lib/status/compute";
import { twinDetail } from "@/lib/status/detail";
import { getTwinGraph } from "@/lib/twin/source";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** One twin with its parts and sensors (for the details drawer). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[\w.:-]{1,128}$/.test(id)) return NextResponse.json({ error: "Bad twin id" }, { status: 400 });
  try {
    const { graph } = await getTwinGraph();
    const detail = twinDetail(new TwinIndex(graph), id, graph.relationships);
    if (!detail) return NextResponse.json({ error: "Not in the digital twin" }, { status: 404 });
    return NextResponse.json(detail);
  } catch (err) {
    console.error(`GET /api/twin/${id}:`, err);
    return NextResponse.json({ error: "Could not read the digital twin" }, { status: 502 });
  }
}

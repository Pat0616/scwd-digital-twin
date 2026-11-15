import { NextResponse } from "next/server";
import { acknowledge } from "@/lib/scada/alarms";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST /api/alarms/ack {"ids": [...]} or {"all": true}: acknowledges alarms for every operator (the stream sends the
 * new list to all of them). */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { ids?: unknown; all?: unknown } | null;
  if (body?.all === true) return NextResponse.json({ acknowledged: acknowledge("all") });
  const ids = Array.isArray(body?.ids) ? body.ids.filter((x): x is string => typeof x === "string" && x.length <= 300).slice(0, 500) : null;
  if (!ids?.length) return NextResponse.json({ error: "Send ids or all" }, { status: 400 });
  return NextResponse.json({ acknowledged: acknowledge(ids) });
}

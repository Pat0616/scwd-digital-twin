import { NextResponse } from "next/server";
import { getHistory, historyKey } from "@/lib/scada/history";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_HOURS = 7 * 24;

/** GET /api/history?id=<twin id>&prop=<property>&hours=<1..168>: one reading's samples, for the SCADA trends. */
export function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const id = q.get("id") ?? "", prop = q.get("prop") ?? "";
  if (!/^[\w.:-]{1,128}$/.test(id) || !/^\w{1,64}$/.test(prop)) return NextResponse.json({ error: "Bad reading" }, { status: 400 });
  const hours = Math.min(MAX_HOURS, Math.max(0.25, Number(q.get("hours")) || 24));
  return NextResponse.json(getHistory(historyKey(id, prop), Date.now() - hours * 3.6e6));
}

import "server-only";
import { createHash } from "node:crypto";
import { loadStatusGis } from "@/lib/gis/load";
import { computeMonitor } from "@/lib/monitor/status";
import { syncAlarms } from "@/lib/scada/alarms";
import { recordHistory } from "@/lib/scada/history";
import { getTwinGraph } from "@/lib/twin/source";
import type { TwinGraph } from "@/lib/twin/types";
import { TwinIndex, computeStatus, type StatusGis } from "./compute";
import type { LiveResponse } from "./types";

export interface LiveStatus {
  /** changes whenever any twin or relationship changes (from their ADT $etags) */
  version: string;
  fetchedAt: string;
  body: LiveResponse;
}

/** A fingerprint of the graph: ADT gives every twin and relationship a new $etag on each update. */
function graphVersion(g: TwinGraph): string {
  const h = createHash("sha1");
  for (const t of [...g.twins].sort((a, b) => a.$dtId.localeCompare(b.$dtId))) h.update(`${t.$dtId}:${String(t.$etag ?? "")}\n`);
  for (const r of [...g.relationships].sort((a, b) => a.$relationshipId.localeCompare(b.$relationshipId)))
    h.update(`${r.$relationshipId}:${String(r.$etag ?? "")}\n`);
  return h.digest("hex").slice(0, 16);
}

// since when each station has been in its current state (monitor "since"); starts from what QGIS exported
const g = globalThis as { __stationSince?: Map<string, { key: string; since: string }> };
const sinceOf = (g.__stationSince ??= new Map());

function stampSince(body: LiveResponse, gis: StatusGis, fetchedAt: string) {
  for (const [id, st] of Object.entries(body.monitor.stations)) {
    const key = `${st.state}|${st.headline}`;
    let rec = sinceOf.get(id);
    if (!rec) {
      const f = gis.facilities.find((x) => x.twin_id === id);
      rec = { key, since: f && `${f.state}|${f.headline}` === key && f.since ? f.since : fetchedAt };
      sinceOf.set(id, rec);
    } else if (rec.key !== key) {
      rec.key = key;
      rec.since = fetchedAt;
    }
    st.since = rec.since;
  }
}

let last: LiveStatus | null = null;

/** The map's live status from the twin (recomputed only when the twin was re-read). */
export async function liveStatus(): Promise<LiveStatus> {
  const { graph, kind, label, shifted, fetchedAt } = await getTwinGraph();
  if (last?.fetchedAt !== fetchedAt) {
    const gis = await loadStatusGis();
    const now = new Date();
    const base = computeStatus(graph, gis, kind, fetchedAt, now);
    const body: LiveResponse = { ...base, label, shifted, monitor: computeMonitor(new TwinIndex(graph), gis, base, now) };
    stampSince(body, gis, fetchedAt);
    recordHistory(body, fetchedAt);                    // the SCADA trends
    syncAlarms(body, gis, fetchedAt);                  // the SCADA alarm list
    // moved reading times change the status without any twin changing (its $etag): send it again once a minute
    const minute = shifted ? `-${Math.floor(Date.now() / 60_000)}` : "";
    last = { version: graphVersion(graph) + minute, fetchedAt, body };
  }
  return last;
}

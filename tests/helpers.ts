import { readFileSync } from "node:fs";
import path from "node:path";
import type { GisMeta } from "@/lib/gis/types";
import type { StatusGis } from "@/lib/status/compute";
import { readingsOf, type TwinReading } from "@/lib/twin/readings";
import type { Relationship, Twin, TwinGraph } from "@/lib/twin/types";

const root = path.resolve(__dirname, "..");
const json = (p: string) => JSON.parse(readFileSync(path.join(root, p), "utf8"));

export const NOW = new Date("2026-11-04T12:00:00Z");

const TIME_KEYS = ["readings_at", "last_seen"] as const;

/** Moves every reading time so the newest one is `now`: the fixture is a snapshot, its readings would go stale. */
export function shiftTimes(twins: Twin[], now: Date): void {
  let newest = -Infinity;
  for (const t of twins)
    for (const k of TIME_KEYS) {
      const ms = typeof t[k] === "string" ? Date.parse(t[k]) : NaN;
      if (!Number.isNaN(ms)) newest = Math.max(newest, ms);
    }
  if (newest === -Infinity) return;
  const delta = now.getTime() - newest;
  for (const t of twins)
    for (const k of TIME_KEYS) {
      const ms = typeof t[k] === "string" ? Date.parse(t[k]) : NaN;
      if (!Number.isNaN(ms)) t[k] = new Date(ms + delta).toISOString();
    }
}

/** The twin fixture (data/, an ADT Explorer export of the v4 instance), with its times moved to NOW. */
export function fixtureGraph(): TwinGraph {
  const g = json("data/scwd_digital_twin_adt_v4.json").digitalTwinsGraph as { digitalTwins: Twin[]; relationships: Relationship[] };
  const graph = { twins: g.digitalTwins, relationships: g.relationships };
  shiftTimes(graph.twins, NOW);
  return graph;
}

/** The imported GIS (public/gis/, from `npm run import-gis`). */
export function gis(): StatusGis & { meta: GisMeta } {
  return {
    meta: json("public/gis/meta.json"),
    facilities: json("public/gis/facilities.json"),
    pipes: json("public/gis/pipes.json"),
    meters: json("public/gis/meters.json"),
    bgyAreas: json("public/gis/bgyAreas.json"),
  };
}

export function twin(g: TwinGraph, id: string) {
  const t = g.twins.find((x) => x.$dtId === id);
  if (!t) throw new Error(`no twin ${id}`);
  return t;
}

/** One reading of a twin: (twin id, property), as the v4 model identifies it. */
export function reading(g: TwinGraph, id: string, property: string): TwinReading {
  const r = readingsOf(twin(g, id)).find((x) => x.property === property);
  if (!r) throw new Error(`no ${property} on ${id}`);
  return r;
}

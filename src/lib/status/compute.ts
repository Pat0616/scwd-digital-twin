// Turns the twin's graph into the map's live status (twin_sync.apply + map_look's derived fields).
// Twin model v4: each reading is a property of the part it measures (lib/twin/readings.ts).

import type { BandKey, GisData, Reading, ReadingGroup, Role } from "@/lib/gis/types";
import { readingsOf, type TwinReading } from "@/lib/twin/readings";
import type { Twin, TwinGraph, TwinSourceKind } from "@/lib/twin/types";
import {
  BGY_STATUS, ROLE_OF_MODEL, ROLE_ORDER, alarmText, bandFor, bgyStatus, gaugeBand, isOnline, modelName, readingText, stationAlerts, type PartState,
} from "./rules";
import type {
  BarangayStatus, GaugeStatus, PartStatus, PipeStatus, StationStatus, StatusResponse,
} from "./types";

export type StatusGis = Pick<GisData, "facilities" | "pipes" | "meters" | "bgyAreas">;

const GAUGE_MODELS = new Set(["DPP", "FarPointSite"]);
const PIPE_MODELS = new Set(["TransmissionPipe", "DistributionPipe"]);

const s = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
/** The twin's issue text; "none" (as typed in ADT Explorer to clear one) is no issue. */
export const issueOf = (t: Twin) => { const v = s(t.issue)?.trim(); return v && v.toLowerCase() !== "none" ? v : null; };

/** The graph, indexed the way the rules read it. */
export class TwinIndex {
  readonly twins = new Map<string, Twin>();
  /** part id -> its pumping station */
  readonly stationOf = new Map<string, string>();
  /** station id -> its parts, in twin order */
  readonly partsOf = new Map<string, Twin[]>();
  private readonly readings = new Map<string, TwinReading[]>();

  constructor(graph: TwinGraph) {
    for (const t of graph.twins) this.twins.set(t.$dtId, t);
    for (const r of graph.relationships)
      if (r.$relationshipName === "partOf" && modelName(this.twins.get(r.$targetId)) === "PumpingStation")
        this.stationOf.set(r.$sourceId, r.$targetId);
    for (const t of graph.twins) {
      const station = this.stationOf.get(t.$dtId);
      if (station) push(this.partsOf, station, t);
    }
  }

  ofModel(model: string): Twin[] {
    return [...this.twins.values()].filter((t) => modelName(t) === model);
  }

  /** The readings a twin carries (its reading properties), [] for an unknown id. */
  readingsOf(id: string): TwinReading[] {
    let rs = this.readings.get(id);
    if (!rs) {
      const t = this.twins.get(id);
      rs = t ? readingsOf(t) : [];
      this.readings.set(id, rs);
    }
    return rs;
  }
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

/** One reading as the map and the drawer show it. */
export function toReading(r: TwinReading): Reading {
  return {
    name: r.display_name, value: readingText(r), alarm: alarmText(r), time: r.readings_at,
    type: r.kind, twin_id: r.twin_id, property: r.property,
    number: r.value_number ?? null, unit: r.unit, min: r.min_value, max: r.max_value,
    online: isOnline(r),
  };
}

/** A station part: working or not, and its issue + its readings' alarms. A telemetry unit that is not online is down. */
export function partStatus(part: Twin, readings: TwinReading[]): PartStatus {
  const alarms = [issueOf(part), ...readings.map(alarmText)].filter((a): a is string => a != null);
  const down = part.operational === false || (modelName(part) === "TelemetryUnit" && part.online === false);
  return { status: down ? "offline" : "operational", alarm: alarms.join("; ") || null };
}

/** Every reading of a station's parts (and of the station itself), grouped by logo in logo order. */
export function stationReadings(idx: TwinIndex, stationId: string): ReadingGroup[] {
  const groups = new Map<Role | "other", Reading[]>();
  for (const target of [stationId, ...(idx.partsOf.get(stationId) ?? []).map((p) => p.$dtId)]) {
    const role = ROLE_OF_MODEL[modelName(idx.twins.get(target))] ?? "other";
    for (const r of idx.readingsOf(target)) push(groups, role, toReading(r));
  }
  return [...ROLE_ORDER, "other" as const].filter((r) => groups.has(r)).map((role) => ({ role, items: groups.get(role)! }));
}

export function stationStatus(idx: TwinIndex, station: Twin, logos: Role[] = ROLE_ORDER): StationStatus {
  const down = station.operational === false || station.station_status === "down";
  const parts: Record<string, PartStatus> = {};
  const states: PartState[] = [];
  for (const part of idx.partsOf.get(station.$dtId) ?? []) {
    const ps = partStatus(part, idx.readingsOf(part.$dtId));
    parts[part.$dtId] = ps;
    states.push({ role: ROLE_OF_MODEL[modelName(part)] ?? null, offline: ps.status === "offline", alarm: ps.alarm });
  }
  const { alerts, slot } = stationAlerts(states, logos, down);
  return {
    status: down ? "offline" : "operational", station_status: s(station.station_status), alarm: issueOf(station),
    alerts, alert_slot: slot, parts, sensors: stationReadings(idx, station.$dtId),
  };
}

/** A DPP (pressure_psi) or far-point (chlorine_residual_ppm) gauge: its reading, band and alarm. */
export function gaugeStatus(idx: TwinIndex, gauge: Twin, now: Date): GaugeStatus | null {
  const rs = idx.readingsOf(gauge.$dtId);
  const r = rs.find((x) => x.property === "pressure_psi") ?? rs.find((x) => x.property === "chlorine_residual_ppm");
  if (!r) return null;
  const online = isOnline(r);
  const value = r.value_number ?? null;
  const time = r.readings_at;
  const kind = r.kind === "pressure" ? "pressure" : "chlorine";
  return {
    kind, value, unit: r.unit, time, online, status: online ? "operational" : "offline",
    band: kind === "pressure" ? gaugeBand(value, online) : null, alarm: alarmText(r),
  };
}

/** A reported fault on a twin pipe marks every segment of it (e.g. the Pangpang leak). */
export function pipeStatus(pipe: Twin): PipeStatus {
  return { alarm: issueOf(pipe) ?? (pipe.operational === false ? "Not operational" : null) };
}

/**
 * Each served barangay's supply status (map_look._bgy_rows): the pressure bands of its pipes (each from its DPP)
 * and of its own current DPP readings, plus the alerts of its stations and gauges.
 */
export function barangayStatuses(
  gis: StatusGis, stations: Record<string, StationStatus>, gauges: Record<string, GaugeStatus>, now: Date,
): Record<string, BarangayStatus> {
  // a DPP's reading counts while its sensor is online, however long ago the value last changed
  const fresh = (g: GaugeStatus | undefined): g is GaugeStatus & { value: number } =>
    !!g && g.kind === "pressure" && g.online && g.value != null;
  const pipeBand = (p: { band: BandKey | null; dpp_twin_id: string | null }) =>
    (p.dpp_twin_id && gauges[p.dpp_twin_id]?.band) || p.band;
  const out: Record<string, BarangayStatus> = {};
  // the export can give two areas one id (Balogo and Balogo Bacon District): served when either is
  const served = new Set(gis.bgyAreas.features.filter((f) => f.properties.status !== "not_served").map((f) => f.properties.id));
  for (const { properties: b } of gis.bgyAreas.features) {
    if (out[b.id] && !served.has(b.id)) continue;
    const pipes = gis.pipes.features.map((f) => f.properties).filter((p) => p.bgy === b.id);
    const meters = gis.meters.features.map((f) => f.properties).filter((m) => m.bgy === b.id);
    const facilities = gis.facilities.filter((f) => f.bgy === b.id);
    const alerts =
      facilities.reduce((sum, f) => {
        const live = f.twin_id ? stations[f.twin_id] : undefined;    // not in the twin yet: the GIS's own count
        return sum + (live ? live.alerts : (f.alerts ?? 0));
      }, 0) +
      meters.filter((m) => (m.twin_id && gauges[m.twin_id] ? gauges[m.twin_id]!.alarm : m.alarm)).length;
    // current readings: its own DPPs and the DPPs its pipes take their band from
    const dppIds = new Set<string>();
    for (const m of meters) if (m.type === "pressure_logger" && m.twin_id) dppIds.add(m.twin_id);
    for (const p of pipes) if (p.dpp_twin_id) dppIds.add(p.dpp_twin_id);
    const readings = [...dppIds].map((id) => gauges[id]).filter(fresh);
    const lowest = readings.reduce<(typeof readings)[number] | null>((lo, g) => (lo && lo.value <= g.value ? lo : g), null);
    const bands = new Set<BandKey | null>([...pipes.map(pipeBand), ...readings.map((g) => bandFor(g.value))]);
    const status = bgyStatus(bands, alerts, served.has(b.id));
    const def = BGY_STATUS.find(([k]) => k === status)!;
    out[b.id] = { status, label: def[1], color: def[2], psi: lowest?.value ?? null, time: lowest?.time ?? null, alerts };
  }
  return out;
}

export function computeStatus(
  graph: TwinGraph, gis: StatusGis, source: TwinSourceKind, fetchedAt: string, now: Date = new Date(),
): StatusResponse {
  const idx = new TwinIndex(graph);
  const logosOf = new Map(gis.facilities.filter((f) => f.twin_id).map((f) => [f.twin_id!, f.roles]));

  const stations: Record<string, StationStatus> = {};
  for (const st of idx.ofModel("PumpingStation")) stations[st.$dtId] = stationStatus(idx, st, logosOf.get(st.$dtId));

  const gauges: Record<string, GaugeStatus> = {};
  const pipes: Record<string, PipeStatus> = {};
  for (const t of idx.twins.values()) {
    const model = modelName(t);
    if (GAUGE_MODELS.has(model)) {
      const g = gaugeStatus(idx, t, now);
      if (g) gauges[t.$dtId] = g;
    } else if (PIPE_MODELS.has(model)) pipes[t.$dtId] = pipeStatus(t);
  }

  return { source, fetchedAt, stations, gauges, pipes, barangays: barangayStatuses(gis, stations, gauges, now) };
}

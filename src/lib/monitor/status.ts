// The "Sorsogon Water Monitor" status in plain words, from the digital twin: one state and one headline per station,
// equipment group, gauge and barangay, plus the city's one-line summary. Mirrors the QGIS plugin's
// monitor_status.py (station_status, meter_status, refresh, city_status) and monitor_web.build_data (the cards).
// It builds on lib/status/compute.ts (twin_sync + map_look), as the plugin's monitor builds on twin_sync's fields.

import type {
  BgyStatusKey, CardGroup, CardReading, DataHealth, Facility, MonGroup, MonState, ProblemPart,
} from "@/lib/gis/types";
import type { StatusGis, TwinIndex } from "@/lib/status/compute";
import { BGY_STATUS, alarmText, bandFor, fmtG, modelName } from "@/lib/status/rules";
import type { StatusResponse } from "@/lib/status/types";
import type { TwinReading } from "@/lib/twin/readings";
import type { Twin } from "@/lib/twin/types";

export const STATES: MonState[] = ["down", "attention", "nodata", "ok", "notwin"];       // worst first
const RANK: Record<string, number> = Object.fromEntries(STATES.map((s, i) => [s, i]));
export const STATE_LABELS: Record<MonState, string> = {
  ok: "Working", attention: "Needs attention", down: "Not working", nodata: "No current data",
  notwin: "Not in the digital twin yet",
};

/** (key, title) of a station's equipment groups, in card order. */
export const GROUPS: [MonGroup, string][] = [
  ["source", "Water source"], ["treatment", "Treatment"], ["pumping", "Pump"], ["vfd", "Pump drive (VFD)"],
  ["storage", "Storage tank"], ["grid", "Grid power"], ["generator", "Generator"],
];
const PART_SLOT: Record<string, MonGroup> = {
  WaterSource: "source", Chlorinator: "treatment", ChlorinatorPump: "treatment", ChlorineTank: "treatment",
  SubmersiblePump: "pumping", DischargePipe: "pumping", VFD: "vfd", StorageTank: "storage", InletValve: "storage",
  OutletValve: "storage", OutletPipe: "storage", GridConnection: "grid", TransferSwitch: "grid", TelemetryUnit: "grid",
  Generator: "generator",
  // water bought in from another water district (e.g. Casiguran WD, Orok Spring): a water source
  BulkSupplyPoint: "source",
};
export const slotOf = (model: string | null | undefined): MonGroup | null => PART_SLOT[model ?? ""] ?? null;

// Data health is the sensors' online flags only: a reading whose value has not changed for a while is not "late"
// (the twin's readings_at moves only when a value is written). See lib/status/rules.ts.

/** The next step for the control room, by the plain problem text (first match wins). */
const ADVICE: [string, string][] = [
  ["Pump stopped", "Check the pump drive (VFD) and restart the pump; send a technician if it trips again"],
  ["Pump drive fault", "Reset the pump drive (VFD); if the fault comes back, have the motor and cable checked"],
  ["Pump drive (VFD) not working", "Send a technician to the pump drive (VFD)"],
  ["Pump drive current", "Have the pump motor and drive checked for overload"],
  ["Tank level low", "Watch the tank level; check the pump and the outlet valve"],
  ["Chlorine tank low", "Refill the chlorine tank"],
  ["Bulk supply", "Call Casiguran WD about the bulk supply; tell the barangays fed from it"],
  ["Generator fuel low", "Refuel the generator"],
  ["Grid power off", "Make sure the generator started; call SORECO about the outage"],
  ["Power supply voltage", "Check the power supply; call SORECO if it continues"],
  ["Low outlet pressure", "Check the pump output and the outlet valve; look for a leak near the station"],
  ["Low pump pressure", "Check the pump output and the outlet valve; look for a leak near the station"],
  ["Water pressure very low", "Little or no water at the taps: check the station feeding this area and look for leaks; advise the barangay"],
  ["Water pressure low", "Check the feeding station's output and look for leaks"],
  ["Water pressure high", "Check the pressure-reducing valves: a risk of pipe bursts"],
  ["Chlorine too low", "Raise chlorine dosing at the feeding station; re-test at the far point"],
  ["Chlorine too high", "Lower chlorine dosing; re-test at the far point"],
  ["leak", "Send a repair crew; isolate the section with its valves if the leak is big"],
  ["not reporting", "Check the sensor's telemetry unit and its power at the site"],
  ["Not reporting", "Check the sensor's telemetry unit and its power at the site"],
  ["No current reading", "Check the sensor's telemetry unit and its power at the site"],
  ["Station not working", "Send a technician to the station"],
  ["not working", "Send a technician to check it"],
];

/** The next step for a plain problem text (headline or issue), or null. */
export function advice(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const [key, step] of ADVICE) if (text.includes(key)) return step;
  return "Check it on site";
}

const PART_NAMES: Record<string, string> = {
  BulkSupplyPoint: "Bulk supply", WaterSource: "Well", SubmersiblePump: "Pump", VFD: "Pump drive (VFD)",
  DischargePipe: "Discharge pipe", Chlorinator: "Chlorinator", ChlorinatorPump: "Chlorine dosing pump",
  ChlorineTank: "Chlorine tank", InletValve: "Inlet valve", StorageTank: "Storage tank", OutletValve: "Outlet valve",
  OutletPipe: "Outlet pipe", GridConnection: "Grid power", Generator: "Generator", TransferSwitch: "Power transfer switch",
  TelemetryUnit: "Telemetry unit",
};
/** The readings shown on a station card, per group, in order: (reading kind, the twin model it is on or null). */
const KEY_READINGS: Record<MonGroup, [string, string | null][]> = {
  source: [["flow", "BulkSupplyPoint"], ["chlorine_residual", "BulkSupplyPoint"]],
  treatment: [["level", "ChlorineTank"], ["dosing_flow", null], ["chlorine_residual", "OutletPipe"]],
  pumping: [["run_status", null], ["pressure", "DischargePipe"], ["flow", "DischargePipe"]],
  vfd: [["speed", null], ["current", null], ["fault_code", null]],
  storage: [["level", "StorageTank"], ["pressure", "OutletPipe"], ["flow", "OutletPipe"]],
  grid: [["power_present", null], ["power_source", null], ["supply_voltage", null]],
  generator: [["fuel_level", null]],
};
const UNITS: Record<string, string> = { lps: "L/s", "L/h": "L/h", "%": "%", "% open": "% open" };
const GROUP_PRIORITY: Record<string, number> = { pumping: 0, vfd: 1, storage: 2, grid: 3, generator: 4, treatment: 5, source: 6 };

/** The worst of some states, or null. */
export function worst(states: (MonState | null | undefined)[]): MonState | null {
  const xs = states.filter((s): s is MonState => !!s);
  return xs.length ? xs.reduce((a, b) => ((RANK[b] ?? 99) < (RANK[a] ?? 99) ? b : a)) : null;
}

// ------------------------------------------------------------------ plain words for one reading / part

type Problem = [MonState, string];

/** (state, plain headline) for a reading that is out of range or not reporting, else null. */
export function sensorProblem(s: TwinReading): Problem | null {
  const kind = s.kind, model = s.twin_model;
  const value = s.value_number ?? null;
  const unit = UNITS[s.unit ?? ""] ?? s.unit ?? "";
  const name = s.display_name || PART_NAMES[model] || "Sensor";
  if (s.sensor_online === false) return ["attention", `${name} sensor not reporting`];
  const text = s.value_text ?? null, flag = s.value_bool ?? null;
  if (kind === "run_status" && text && ["stopped", "tripped", "fault"].includes(text.toLowerCase())) return ["down", "Pump stopped"];
  if (kind === "fault_code" && text && !["none", "ok", "0"].includes(text.toLowerCase())) return ["attention", `Pump drive fault (${text})`];
  if (kind === "power_present" && flag === false) return ["attention", "Grid power off"];
  if (!s.in_alarm) return null;
  const lo = s.min_value;
  const low = lo != null && value != null && value < lo;
  const shown = value != null ? `${fmtG(value)}${unit === "%" ? "%" : unit ? " " + unit : ""}` : "";
  if (kind === "level" && model === "StorageTank") return ["attention", `Tank level low (${shown})`];
  if (kind === "level" && model === "ChlorineTank") return ["attention", `Chlorine tank low (${shown})`];
  if (kind === "flow" && model === "BulkSupplyPoint")
    return ["attention", low ? `Bulk supply low (${shown}${lo != null ? `, min ${fmtG(lo)}` : ""})` : `Bulk supply flow abnormal (${shown})`];
  if (kind === "fuel_level") return ["attention", `Generator fuel low (${shown})`];
  if (kind === "pressure" && model === "OutletPipe") return ["attention", `Low outlet pressure (${shown})`];
  if (kind === "pressure" && model === "DischargePipe") return ["attention", `Low pump pressure (${shown})`];
  if (kind === "pressure" && model === "DPP") {
    const very = value != null && value < 3;
    return [very ? "down" : "attention", `Water pressure ${very ? "very " : ""}low (${shown})`];
  }
  if (kind === "chlorine_residual") return ["attention", `Chlorine too ${low ? "low" : "high"} (${shown})`];
  if (kind === "supply_voltage") return ["attention", `Power supply voltage ${low ? "low" : "high"} (${shown})`];
  if (kind === "current") return ["attention", `Pump drive current abnormal (${shown})`];
  return ["attention", shown ? `${name} out of range (${shown})` : `${name} out of range`];
}

/** A part is not working (twin_sync._part_offline). */
export const partOffline = (t: Twin) => t.operational === false || (modelName(t) === "TelemetryUnit" && t.online === false);

/** (state, plain headline) for a twin part that is not working, else null. */
export function partProblem(t: Twin): Problem | null {
  const model = modelName(t);
  const name = PART_NAMES[model] ?? (typeof t.display_name === "string" ? t.display_name : "Part");
  if (partOffline(t)) return ["down", model === "SubmersiblePump" ? "Pump stopped" : `${name} not working`];
  return null;
}

/** '22%', '4.1 L/s', 'stopped', 'yes' for one reading (monitor_status.reading_text). */
export function monReadingText(s: TwinReading): string {
  if (s.value_number != null) {
    const unit = UNITS[s.unit ?? ""] ?? s.unit ?? "";
    return unit === "%" ? `${fmtG(s.value_number)}%` : `${fmtG(s.value_number)} ${unit}`.trim();
  }
  if (s.value_text != null) return String(s.value_text);
  if (s.value_bool != null) return s.value_bool ? "yes" : "no";
  return "no reading";
}

function cardReading(s: TwinReading): CardReading {
  return {
    name: s.display_name, value: monReadingText(s), alarm: alarmText(s), offline: s.sensor_online === false,
    time: s.readings_at, unit: s.unit, pct: s.unit === "%" ? (s.value_number ?? null) : null,
    min: s.min_value, max: s.max_value, twin_id: s.twin_id, property: s.property,
  };
}

// ------------------------------------------------------------------ one station

interface Issue { state: MonState; text: string; group: MonGroup | null }

export interface StationResult {
  state: MonState;
  headline: string;
  issues: Issue[];
  groups: Partial<Record<MonGroup, MonState>>;
  data: DataHealth;
  standby: boolean;
  down: boolean;
}

/** Everything about one twin-backed station (monitor_status.station_status). */
export function stationResult(station: Twin, parts: Twin[], sensors: TwinReading[], now: Date): StationResult {
  const standby = station.station_status === "standby";
  const issues: Issue[] = [];
  const groups: Partial<Record<MonGroup, MonState>> = Object.fromEntries(GROUPS.map(([g]) => [g, "ok" as MonState]));
  let orphan: MonState | null = null;                  // a part without a group (the plugin keeps it under None)
  for (const c of parts) {
    const g = slotOf(modelName(c));
    const p = partProblem(c);
    if (!p) continue;
    issues.push({ state: p[0], text: p[1], group: g });
    if (g) groups[g] = worst([groups[g], p[0]])!;
    else orphan = worst([orphan, p[0]]);
  }
  for (const s of sensors) {
    const g = slotOf(s.twin_model);
    let p = sensorProblem(s);
    if (p && standby && s.kind === "run_status") p = null;     // a stopped pump is normal on a standby station
    if (!p) continue;
    issues.push({ state: p[0], text: p[1], group: g });
    if (g && g in groups) groups[g] = worst([groups[g], p[0]])!;
  }
  const down = station.operational === false || station.station_status === "down" || groups.pumping === "down";
  let state: MonState = down ? "down" : (worst([...Object.values(groups), orphan]) ?? "ok");
  if (state === "down" && !down) state = "attention";   // a part down but the station still pumping
  // one plain line per problem, worst first, no repeats
  const key = (i: Issue) => [RANK[i.state] ?? 99, i.text.includes("not reporting") ? 1 : 0, GROUP_PRIORITY[i.group ?? ""] ?? 9];
  const sorted = [...issues].sort((a, b) => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i]! - kb[i]!;
    return 0;
  });
  const seen = new Set<string>();
  const ordered = sorted.filter((i) => !seen.has(i.text) && (seen.add(i.text), true));
  if (down && !ordered.length) ordered.push({ state: "down", text: "Station not working", group: "pumping" });
  let data: DataHealth = "none";
  if (sensors.length) {
    data = sensors.some((s) => s.sensor_online === false) ? "offline" : "live";
  }
  let headline = ordered[0]?.text ?? (standby ? "On standby" : "All working");
  if (ordered.length > 1) headline += ` (+${ordered.length - 1} more)`;
  return { state, headline, issues: ordered, groups, data, standby, down };
}

/** The parts of a station with a problem, worst first; one whose only problems are sensors not reporting gets the
 * grey 'nodata' sign (monitor_status.problem_parts). */
export function problemParts(st: StationResult): ProblemPart[] {
  if (st.state === "ok" || st.state === "notwin") return [];
  const out: ProblemPart[] = [];
  for (const [g] of GROUPS) {
    const state = st.groups[g];
    if (state !== "down" && state !== "attention") continue;
    const texts = st.issues.filter((i) => i.group === g).map((i) => i.text);
    const sign: MonState = state === "attention" && texts.length && texts.every((t) => t.includes("not reporting")) ? "nodata" : state;
    out.push({ group: g, state: sign });
  }
  const rank = (s: MonState) => (s === "nodata" ? 2.5 : (RANK[s] ?? 9));
  return out.sort((a, b) => rank(a.state) - rank(b.state) || (GROUP_PRIORITY[a.group] ?? 9) - (GROUP_PRIORITY[b.group] ?? 9));
}

/** The station card: groups with their state, parts, key readings and every reading (monitor_status.station_card). */
export function cardGroups(st: StationResult, parts: Twin[], sensors: TwinReading[]): CardGroup[] {
  const out: CardGroup[] = [];
  for (const [g, title] of GROUPS) {
    const gparts = parts.filter((c) => slotOf(modelName(c)) === g);
    const gsens = sensors.filter((s) => slotOf(s.twin_model) === g);
    if (!gparts.length && !gsens.length) continue;
    const key: TwinReading[] = [];
    for (const [kind, model] of KEY_READINGS[g]) {
      const s = sensors.find((x) => x.kind === kind && (model == null || x.twin_model === model));
      if (s) key.push(s);
    }
    out.push({
      group: g, title, state: st.groups[g] ?? "nodata",
      issues: st.issues.filter((i) => i.group === g).map((i) => i.text),
      parts: gparts.map((c) => ({ name: typeof c.display_name === "string" ? c.display_name : null, ok: !partOffline(c) })),
      key: key.map(cardReading), all: gsens.map(cardReading),
    });
  }
  return out;
}

// ------------------------------------------------------------------ one gauge

export interface GaugeResult { state: MonState; headline: string; data: DataHealth }

/** State and plain headline for a gauge (monitor_status.meter_status). */
export function gaugeResult(type: string, reading: { value: number | null; time: string | null; online: boolean }, now: Date): GaugeResult {
  if (!reading.online) return { state: "nodata", headline: "Not reporting", data: "offline" };
  const data: DataHealth = "live";                    // online: reporting, however long its value has been the same
  const v = reading.value;
  if (type === "pressure_logger") {
    if (v == null) return { state: "nodata", headline: "No current reading", data };
    const band = bandFor(v);
    const txt = `${fmtG(v)} psi`;
    const state: MonState = band === "very_low" ? "down" : band === "low" || band === "high" ? "attention" : "ok";
    const headline = band === "very_low" ? `Water pressure very low (${txt})` : band === "low" ? `Water pressure low (${txt})`
      : band === "high" ? `Water pressure high (${txt})` : `Water pressure OK (${txt})`;
    return { state, headline, data };
  }
  if (type === "chlorine_point") {
    if (v == null) return { state: "nodata", headline: "No current reading", data };
    if (v < 0.3) return { state: "attention", headline: `Chlorine too low (${fmtG(v)} ppm)`, data };
    if (v > 1.5) return { state: "attention", headline: `Chlorine too high (${fmtG(v)} ppm)`, data };
    return { state: "ok", headline: `Chlorine OK (${fmtG(v)} ppm)`, data };
  }
  return { state: "ok", headline: STATE_LABELS.ok, data };
}

// ------------------------------------------------------------------ the whole map

/** The live monitor fields of a station, gauge, pipe and barangay, keyed like the rest of the status. */
export interface StationLive {
  status: "operational" | "offline";
  alarm: string | null;
  state: MonState;
  headline: string;
  issues: string[];
  data: DataHealth;
  standby: boolean;
  problems: ProblemPart[];
  groups: CardGroup[];
  action: string | null;
  affects: string | null;
  /** filled in by lib/status/live.ts: when this state and headline were first seen */
  since: string | null;
}

export interface GaugeLive {
  state: MonState;
  headline: string;
  data: DataHealth;
  action: string | null;
  affects: string | null;
}

export interface PipeLive { alarm: string | null; action: string | null }
export interface BarangayLive { state: MonState | null; headline: string }

export interface MonitorStatus {
  city: { state: MonState; text: string };
  /** by station twin id (pumping stations and bulk supply points) */
  stations: Record<string, StationLive>;
  /** by gauge twin id */
  gauges: Record<string, GaugeLive>;
  /** by twin pipe id */
  pipes: Record<string, PipeLive>;
  /** by barangay GIS id */
  barangays: Record<string, BarangayLive>;
}

const BARANGAY_STATE: Record<BgyStatusKey, MonState | null> = {
  very_low: "down", low: "attention", station_alert: "attention", high: "attention", no_reading: "nodata",
  no_gauge: "nodata", normal: "ok", not_served: null,
};

/** {station name: [barangay names]} the barangays each station's pipes run through, most pipe length first. */
function fedBarangays(gis: StatusGis, names: Map<string, string>): Map<string, string[]> {
  const length = new Map<string, Map<string, number>>();
  for (const { properties: p } of gis.pipes.features) {
    const name = p.bgy ? names.get(p.bgy) : undefined;
    if (!p.supply || !name) continue;
    const per = length.get(p.supply) ?? new Map<string, number>();
    per.set(name, (per.get(name) ?? 0) + (p.length ?? 0));
    length.set(p.supply, per);
  }
  return new Map([...length].map(([s, per]) => [s, [...per].sort((a, b) => b[1] - a[1]).map(([n]) => n)]));
}

/** The monitor status of every twin-backed station, gauge, pipe and barangay (monitor_status.refresh + city_status). */
export function computeMonitor(idx: TwinIndex, gis: StatusGis, base: StatusResponse, now: Date): MonitorStatus {
  const names = new Map(gis.bgyAreas.features.map((f) => [f.properties.id, f.properties.name]));
  const fed = fedBarangays(gis, names);
  const byBgy = new Map<string, [MonState, string][]>();
  const note = (bgy: string | null, item: [MonState, string]) => {
    if (!bgy) return;
    const list = byBgy.get(bgy) ?? [];
    list.push(item);
    byBgy.set(bgy, list);
  };
  const bad = (s: MonState) => s === "down" || s === "attention" || s === "nodata";

  // stations (and bulk supply points), in GIS order
  const stations: Record<string, StationLive> = {};
  const stationStates: MonState[] = [];
  for (const f of gis.facilities as Facility[]) {
    const t = f.twin_id ? idx.twins.get(f.twin_id) : undefined;
    if (!t) continue;
    const parts = idx.partsOf.get(t.$dtId) ?? [];
    const sensors = [t, ...parts].flatMap((x) => idx.readingsOf(x.$dtId));
    const st = stationResult(t, parts, sensors, now);
    const isBad = bad(st.state) && st.issues.length > 0;
    const own = f.bgy ? names.get(f.bgy) : undefined;
    const affects = fed.get(f.name) ?? (own ? [own] : []);
    stations[t.$dtId] = {
      status: t.operational === false || t.station_status === "down" ? "offline" : "operational",
      alarm: typeof t.issue === "string" && t.issue.trim() && t.issue.trim().toLowerCase() !== "none" ? t.issue.trim() : null,
      state: st.state, headline: st.headline, issues: st.issues.map((i) => i.text), data: st.data, standby: st.standby,
      problems: problemParts(st), groups: cardGroups(st, parts, sensors),
      action: isBad ? advice(st.issues[0]!.text) : null,
      affects: isBad && affects.length ? affects.join(", ") : null,
      since: null,
    };
    stationStates.push(st.state);
    if (st.state === "down" || st.state === "attention")
      note(f.bgy, [st.state, `${f.name}: ${st.issues[0]?.text ?? st.headline}`]);
  }

  // gauges, in GIS order
  const gauges: Record<string, GaugeLive> = {};
  let gaugesNoData = 0;
  for (const { properties: m } of gis.meters.features) {
    const g = m.twin_id ? base.gauges[m.twin_id] : undefined;
    if (!m.twin_id || !g) continue;
    const r = gaugeResult(m.type, g, now);
    const here = m.bgy ? names.get(m.bgy) ?? null : null;
    gauges[m.twin_id] = { ...r, action: bad(r.state) ? advice(r.headline) : null, affects: bad(r.state) ? here : null };
    if (r.state === "nodata") gaugesNoData++;
    if (bad(r.state)) note(m.bgy, [r.state, `${m.name}: ${r.headline}`]);
  }

  // pipes: a reported fault and what to do about it
  const pipes: Record<string, PipeLive> = {};
  for (const [id, p] of Object.entries(base.pipes)) pipes[id] = { alarm: p.alarm, action: p.alarm ? advice(p.alarm) : null };

  // barangays: their supply status (map_look) and the worst problem in them
  const barangays: Record<string, BarangayLive> = {};
  for (const [id, b] of Object.entries(base.barangays)) {
    let state = BARANGAY_STATE[b.status];
    const items = [...(byBgy.get(id) ?? [])].sort((x, y) => (RANK[x[0]] ?? 99) - (RANK[y[0]] ?? 99));
    let headline: string;
    if (state == null) headline = "Not served";
    else if (b.status === "no_gauge" && !items.length) headline = "No pressure point yet";
    else if (items.length) {
      headline = items[0]![1] + (items.length > 1 ? ` (+${items.length - 1} more)` : "");
      state = worst([state, items[0]![0]]);
    } else headline = state === "ok" ? "All OK" : state === "nodata" ? "No current reading" : (BGY_STATUS.find(([k]) => k === b.status)?.[1] ?? "");
    barangays[id] = { state, headline };
  }

  // the whole system in one plain line
  const n = (xs: (MonState | null)[], s: MonState) => xs.filter((x) => x === s).length;
  const bgyStates = Object.values(barangays).map((b) => b.state).filter((s): s is MonState => !!s);
  const sd = n(stationStates, "down"), sa = n(stationStates, "attention");
  const bd = n(bgyStates, "down"), ba = n(bgyStates, "attention");
  const plural = (k: number, w: string) => `${k} ${w}${k > 1 ? "s" : ""}`;
  const parts: string[] = [];
  if (sd) parts.push(`${plural(sd, "station")} not working`);
  if (sa) parts.push(`${plural(sa, "station")} need${sa === 1 ? "s" : ""} attention`);
  if (bd) parts.push(`${plural(bd, "barangay")} with little or no water`);
  if (ba) parts.push(`${plural(ba, "barangay")} with a problem`);
  if (gaugesNoData) parts.push(`${plural(gaugesNoData, "sensor")} not reporting`);
  const cityState: MonState = !parts.length ? "ok" : sd || bd ? "down" : "attention";
  const city = {
    state: cityState,
    text: !parts.length ? `All working · ${stationStates.length} stations, ${n(bgyStates, "ok")} barangays OK`
      : (cityState === "down" ? "Not all OK: " : "Needs attention: ") + parts.join(" · "),
  };
  return { city, stations, gauges, pipes, barangays };
}

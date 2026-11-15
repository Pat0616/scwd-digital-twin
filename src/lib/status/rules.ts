// The status rules of the QGIS plugin, mirrored in TypeScript:
//   twin_sync.py    ROLE_OF_MODEL, _alarm_text, reading_text
//   setup_layers.py PRESSURE_BANDS, band_for, STALE_READING_HOURS
//   map_look.py     refresh_facility_roles (alerts, alert_slot), _bgy_status, BGY_STATUS
// Keep them in step with the plugin: the web map must show the same picture as QGIS.

import type { BandKey, BgyStatusKey, Role } from "@/lib/gis/types";
import type { Twin } from "@/lib/twin/types";

export const ROLE_ORDER: Role[] = ["source", "treatment", "pumping", "storage", "generator"];

/** The twin's station parts -> the five logos on the building. */
export const ROLE_OF_MODEL: Record<string, Role> = {
  WaterSource: "source",
  Chlorinator: "treatment", ChlorinatorPump: "treatment", ChlorineTank: "treatment",
  SubmersiblePump: "pumping", VFD: "pumping", DischargePipe: "pumping",
  StorageTank: "storage", InletValve: "storage", OutletValve: "storage", OutletPipe: "storage",
  Generator: "generator", GridConnection: "generator", TransferSwitch: "generator",
  TelemetryUnit: "generator",
};

export const ROLE_TITLES: Record<Role, string> = {
  source: "Water source", treatment: "Chlorination", pumping: "Pumping", storage: "Storage",
  generator: "Power & telemetry",
};

// A reading's age does not say whether its sensor works: the twin's readings_at only moves when a value is written,
// and a sensor reading the same pressure for days is still reporting. Only <base>_sensor_online = false is "no
// current reading" (user, 2026-11-15).
/** SCWD's minimum pressure at its Designated Pressure Points (DPPs). */
export const MIN_DPP_PSI = 7;

/** [key, lower psi (inclusive), upper psi (exclusive)] */
export const PRESSURE_BANDS: [BandKey, number | null, number | null][] = [
  ["very_low", null, 3],
  ["low", 3, MIN_DPP_PSI],
  ["ok", MIN_DPP_PSI, 80],
  ["high", 80, null],
];

/** Supply status of a barangay, worst first: key, legend label, colour. */
export const BGY_STATUS: [BgyStatusKey, string, string][] = [
  ["very_low", "Very low pressure", "#b71c1c"],
  ["low", "Low pressure", "#e65100"],
  ["station_alert", "Alert (station or gauge)", "#6a1b9a"],
  ["high", "High pressure", "#1565c0"],
  ["no_reading", "Pressure point offline", "#616161"],
  ["no_gauge", "No pressure point (DPP) yet", "#9fb6c3"],
  ["normal", "Normal", "#2e7d32"],
  ["not_served", "Not served", "#d7ccc8"],
];

/** 'dtmi:scwd:digitaltwin:StorageTank;1' -> 'StorageTank'. */
export function modelName(twin: Pick<Twin, "$metadata"> | undefined): string {
  const model = twin?.$metadata?.$model ?? "";
  return (model.split(":").pop() ?? "").split(";")[0] ?? "";
}

/** A number as Python's f"{x:g}" writes it: 22.0 -> "22", 0.25 -> "0.25". */
export function fmtG(x: number): string {
  if (!Number.isFinite(x)) return String(x);
  const p = Number(x.toPrecision(6));
  const a = Math.abs(p);
  if (a !== 0 && (a >= 1e6 || a < 1e-4)) {
    const [m = "", e = ""] = p.toExponential(5).split("e");
    const exp = e.replace(/^[+-]/, "").padStart(2, "0");
    return `${Number(m)}e${e.startsWith("-") ? "-" : "+"}${exp}`;
  }
  return String(p);
}

/** The reading fields the rules read (lib/twin/readings.ts TwinReading). */
export interface ReadingLike {
  display_name?: unknown;
  kind?: unknown;
  sensor_online?: unknown;
  in_alarm?: unknown;
  value_number?: unknown;
  value_text?: unknown;
  value_bool?: unknown;
  unit?: unknown;
  min_value?: unknown;
  max_value?: unknown;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** A reading's sensor reports unless the twin says <base>_sensor_online is false. */
export function isOnline(s: ReadingLike): boolean {
  return s.sensor_online !== false;
}

/** Why a reading is flagged, e.g. "Storage tank level 22 % (min 25)", or null (twin_sync.alarm_text). */
export function alarmText(s: ReadingLike): string | null {
  const name = str(s.display_name) ?? str(s.kind) ?? "Reading";
  if (!isOnline(s)) return `${name}: sensor offline`;
  if (!s.in_alarm) return null;
  const value = num(s.value_number);
  const unit = str(s.unit) ? ` ${String(s.unit)}` : "";
  const lo = num(s.min_value), hi = num(s.max_value);
  const limits: string[] = [];
  if (lo != null && value != null && value < lo) limits.push(`min ${fmtG(lo)}`);
  if (hi != null && value != null && value > hi) limits.push(`max ${fmtG(hi)}`);
  const shown = value != null ? `${fmtG(value)}${unit}` : (str(s.value_text) ?? "");
  return `${name} ${shown}` + (limits.length ? ` (${limits.join(", ")})` : "");
}

/** "48 psi", "running", "yes" … (twin_sync.reading_text). */
export function readingText(s: ReadingLike): string {
  const value = num(s.value_number);
  if (value != null) return `${fmtG(value)} ${str(s.unit) ?? ""}`.trim();
  if (s.value_text != null) return String(s.value_text);
  if (typeof s.value_bool === "boolean") return s.value_bool ? "yes" : "no";
  return "—";
}

/** Pressure band of a reading, however old (setup_layers.band_for). */
export function bandFor(psi: number | null): BandKey {
  if (psi == null) return "none";
  for (const [key, lo, hi] of PRESSURE_BANDS) if ((lo == null || psi >= lo) && (hi == null || psi < hi)) return key;
  return "none";
}

/** A DPP's band: an offline gauge counts as no current reading ("stale"; map_look.refresh_dmas). */
export function gaugeBand(psi: number | null, online: boolean): BandKey {
  if (psi == null) return "none";
  if (!online) return "stale";
  return bandFor(psi);
}

/** Hours between an ISO time and now; null when there is no time. */
export function hoursOld(time: string | null | undefined, now: Date): number | null {
  if (!time) return null;
  const ms = Date.parse(time);
  return Number.isNaN(ms) ? null : (now.getTime() - ms) / 3.6e6;
}

/** A station part (or the station) with a problem: not working, or flagged by the twin or its sensors. */
export interface PartState {
  role: Role | null;
  offline: boolean;
  alarm: string | null;
}

/**
 * Where the red "!" goes and how many problems a station has (map_look.refresh_facility_roles):
 * on the logo of the first part, in role order, that has a problem; the roof corner (-1) when the station is down
 * without a part to blame; null when nothing is wrong.
 */
export function stationAlerts(parts: PartState[], logos: Role[], stationDown: boolean): { alerts: number; slot: number | null } {
  const bad = (p: PartState) => p.offline || p.alarm != null;
  const alerts = parts.filter(bad).length + (stationDown ? 1 : 0);
  const order = (r: Role | null) => (r == null ? 99 : ROLE_ORDER.indexOf(r));
  const problem = [...parts].sort((a, b) => order(a.role) - order(b.role)).find(bad)?.role ?? null;
  if (problem != null && logos.includes(problem)) return { alerts, slot: logos.indexOf(problem) };
  return { alerts, slot: alerts ? -1 : null };
}

/** A barangay's supply status from its pressure bands and alerts, worst first (map_look._bgy_status). */
export function bgyStatus(bands: Set<BandKey | null>, alerts: number, served: boolean): BgyStatusKey {
  if (!served) return "not_served";
  if (bands.has("very_low")) return "very_low";
  if (bands.has("low")) return "low";
  if (alerts) return "station_alert";
  if (bands.has("high")) return "high";
  if (bands.has("ok")) return "normal";
  // a gauge that is offline vs. a served barangay with no pressure point in the digital twin yet
  return bands.has("stale") ? "no_reading" : "no_gauge";
}

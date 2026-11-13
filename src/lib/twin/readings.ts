// The readings of a twin, as the v4 model holds them: each reading is a property of the part it measures, e.g. on
// a DPP pressure_psi, pressure_psi_min, pressure_psi_alarm, pressure_sensor_online, readings_at. A reading is
// identified by (part twin id, property). Mirrors twin_sync.readings_of in the QGIS plugin.

import type { Twin } from "./types";

type ValueType = "number" | "text" | "bool";
/** [property, kind, unit, value type, the property saying whether its sensor reports] */
export const READINGS: [string, string, string | null, ValueType, string][] = [
  ["pressure_psi", "pressure", "psi", "number", "pressure_sensor_online"],
  ["flow_lps", "flow", "lps", "number", "flow_sensor_online"],
  ["level_pct", "level", "%", "number", "level_sensor_online"],
  ["chlorine_residual_ppm", "chlorine_residual", "ppm", "number", "chlorine_residual_sensor_online"],
  ["fuel_level_pct", "fuel_level", "%", "number", "fuel_level_sensor_online"],
  ["current_a", "current", "A", "number", "current_sensor_online"],
  ["speed_hz", "speed", "Hz", "number", "speed_sensor_online"],
  ["supply_voltage_v", "supply_voltage", "V", "number", "supply_voltage_sensor_online"],
  ["dosing_flow_lph", "dosing_flow", "L/h", "number", "dosing_flow_sensor_online"],
  ["valve_position_pct_open", "valve_position", "% open", "number", "valve_position_sensor_online"],
  ["run_status", "run_status", null, "text", "run_status_sensor_online"],
  ["power_source", "power_source", null, "text", "power_source_sensor_online"],
  ["fault_code", "fault_code", null, "text", "fault_code_sensor_online"],
  ["power_present", "power_present", null, "bool", "power_present_sensor_online"],
];

/** How a reading is named on the cards; {name} = the twin's name, {short} = the supplier, shortened. */
const NAMES: Record<string, string> = {
  "DischargePipe/pressure": "Discharge pressure", "DischargePipe/flow": "Production flow",
  "OutletPipe/pressure": "Outlet pressure", "OutletPipe/flow": "Outlet flow",
  "OutletPipe/chlorine_residual": "Outlet chlorine residual",
  "StorageTank/level": "Storage tank level", "ChlorineTank/level": "Chlorine tank level",
  "Generator/fuel_level": "Generator fuel level",
  "VFD/current": "VFD current", "VFD/speed": "VFD output frequency",
  "VFD/supply_voltage": "VFD supply voltage", "VFD/fault_code": "VFD fault code",
  "ChlorinatorPump/dosing_flow": "Chlorine dosing flow",
  "InletValve/valve_position": "Inlet valve position", "OutletValve/valve_position": "Outlet valve position",
  "SubmersiblePump/run_status": "Pump run status", "TransferSwitch/power_source": "Power source in use",
  "GridConnection/power_present": "Grid power present",
  "DPP/pressure": "{name} pressure",
  "BulkSupplyPoint/flow": "{short} bulk delivered flow",
  "BulkSupplyPoint/chlorine_residual": "{short} bulk chlorine residual",
};

/** One reading of a twin (field names as in the QGIS "Twin Readings" table). */
export interface TwinReading {
  twin_id: string;
  twin_model: string;
  property: string;
  kind: string;
  display_name: string;
  value_number?: number | null;
  value_text?: string | null;
  value_bool?: boolean | null;
  unit: string | null;
  min_value: number | null;
  max_value: number | null;
  in_alarm: boolean | null;
  sensor_online: boolean;
  readings_at: string | null;
}

const modelOf = (t: Twin) => t.$metadata?.$model?.split(":").pop()?.split(";")[0] ?? "";
const numOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function readingName(t: Twin, model: string, kind: string): string {
  const name = typeof t.display_name === "string" ? t.display_name : t.$dtId;
  if (model === "FarPointSite" && kind === "chlorine_residual")
    return "Far-point chlorine residual, " + name.split(",").slice(1).join(",").trim();
  const short = (typeof t.supplier === "string" ? t.supplier : name).split(" Water District")[0] ?? name;
  const pattern = NAMES[`${model}/${kind}`];
  return pattern ? pattern.replace("{name}", name).replace("{short}", short) : `${name} ${kind.replace(/_/g, " ")}`;
}

/** The readings a twin carries, one per reading property present, in READINGS order. */
export function readingsOf(t: Twin): TwinReading[] {
  const model = modelOf(t);
  const out: TwinReading[] = [];
  for (const [prop, kind, unit, vtype, onlineFlag] of READINGS) {
    if (!(prop in t)) continue;
    const r: TwinReading = {
      twin_id: t.$dtId, twin_model: model, property: prop, kind, display_name: readingName(t, model, kind),
      unit: null, min_value: null, max_value: null, in_alarm: null,
      sensor_online: t[onlineFlag] !== false, readings_at: typeof t.readings_at === "string" ? t.readings_at : null,
    };
    if (vtype === "number") {
      Object.assign(r, {
        value_number: numOrNull(t[prop]), unit, in_alarm: Boolean(t[`${prop}_alarm`]),
        min_value: numOrNull(t[`${prop}_min`]), max_value: numOrNull(t[`${prop}_max`]),
      });
    } else if (vtype === "text") r.value_text = t[prop] == null ? null : String(t[prop]);
    else r.value_bool = typeof t[prop] === "boolean" ? (t[prop] as boolean) : null;
    out.push(r);
  }
  return out;
}

const READING_KEYS = new Set(READINGS.flatMap(([p, , , , online]) => [p, `${p}_min`, `${p}_max`, `${p}_alarm`, online]));
/** Whether a twin property belongs to a reading (not a spec): the value, its limits, alarm and sensor flags. */
export const isReadingKey = (k: string) => READING_KEYS.has(k) || k === "readings_at" || k === "in_alarm";

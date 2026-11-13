// GET /api/status: only what the map needs, keyed by twin id (barangays by their GIS id).

import type { BandKey, BgyStatusKey, ReadingGroup } from "@/lib/gis/types";
import type { MonitorStatus } from "@/lib/monitor/status";
import type { TwinSourceKind } from "@/lib/twin/types";

export type WorkState = "operational" | "offline";

export interface PartStatus {
  status: WorkState;
  /** the part issue and its readings alarms, "; "-joined */
  alarm: string | null;
}

export interface StationStatus {
  status: WorkState;
  /** the twin's station_status, e.g. "operating", "standby", "down" */
  station_status: string | null;
  /** the station's own issue */
  alarm: string | null;
  alerts: number;
  alert_slot: number | null;
  /** by part twin id */
  parts: Record<string, PartStatus>;
  /** readings grouped by logo, in logo order */
  sensors: ReadingGroup[];
}

export interface GaugeStatus {
  kind: "pressure" | "chlorine" | "other";
  value: number | null;
  unit: string | null;
  time: string | null;
  /** pressure band (DPPs only) */
  band: BandKey | null;
  online: boolean;
  status: WorkState;
  alarm: string | null;
}

export interface PipeStatus {
  alarm: string | null;
}

export interface BarangayStatus {
  status: BgyStatusKey;
  label: string;
  color: string;
  /** lowest current DPP pressure */
  psi: number | null;
  time: string | null;
  alerts: number;
}

export interface StatusResponse {
  source: TwinSourceKind;
  /** when the twin was read */
  fetchedAt: string;
  stations: Record<string, StationStatus>;
  gauges: Record<string, GaugeStatus>;
  pipes: Record<string, PipeStatus>;
  barangays: Record<string, BarangayStatus>;
}

/** What /api/status and the stream send: the twin status above plus the monitor's plain-language status. */
export interface LiveResponse extends StatusResponse {
  /** the instance host or the twin file name */
  label: string;
  /** true when the readings' times were moved to now (TWIN_AS_OF_NOW, a demo of a snapshot) */
  shifted: boolean;
  monitor: MonitorStatus;
}

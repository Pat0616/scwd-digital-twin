// Static GIS layers of the "Sorsogon Water Monitor" QGIS project, as its web export writes them (plugin:
// monitor_web.export -> web-monitor/data.js) and scripts/import-gis.ts splits them into public/gis/.
// Twin-backed features carry twin_id (= the twin's $dtId); null means "not in the twin yet".

import type { Feature, FeatureCollection, LineString, MultiLineString, MultiPolygon, Point, Polygon } from "geojson";

export type Role = "source" | "treatment" | "pumping" | "storage" | "generator";
export type BandKey = "very_low" | "low" | "ok" | "high" | "stale" | "none";
export type BgyStatusKey =
  | "very_low" | "low" | "station_alert" | "high" | "no_reading" | "no_gauge" | "normal" | "not_served";
export type PipeClass = "transmission" | "dist_main" | "dist_secondary" | "service";
export type MeterType = "pressure_logger" | "chlorine_point" | "inlet_flow" | "bulk";

/** The monitor's plain states, worst first (monitor_status.STATES). */
export type MonState = "down" | "attention" | "nodata" | "ok" | "notwin";
/** A station's equipment groups (monitor_status.GROUPS). */
export type MonGroup = "source" | "treatment" | "pumping" | "vfd" | "storage" | "grid" | "generator";
/** Freshness of a site's readings: all live, some late (> 1 h), a sensor offline, or none. */
export type DataHealth = "live" | "late" | "offline" | "none";
/** What a site is drawn as on the map. */
export type SiteKind = "station" | "bulk" | "proposed" | "reservoir" | "spring" | "intake";

/** One live reading of a station part, as the API's detail route returns it. */
export interface Reading {
  name: string | null;
  value: string;
  alarm: string | null;
  time: string | null;
  type: string | null;
  twin_id: string | null;
  property: string | null;
  number: number | null;
  unit: string | null;
  min: number | null;
  max: number | null;
  online: boolean;
}

export interface ReadingGroup {
  role: Role | "other";
  items: Reading[];
}

/** One reading on a station card (monitor_web._reading). */
export interface CardReading {
  name: string | null;
  value: string;
  alarm: string | null;
  offline: boolean;
  time: string | null;
  unit: string | null;
  /** the value, for a percentage (the card's bar) */
  pct: number | null;
  min: number | null;
  max: number | null;
  twin_id: string | null;
  property: string | null;
}

/** One equipment group on a station card. */
export interface CardGroup {
  group: MonGroup;
  title: string;
  state: MonState;
  issues: string[];
  parts: { name: string | null; ok: boolean }[];
  /** the group's key readings (monitor_status.KEY_READINGS) */
  key: CardReading[];
  /** every reading of the group */
  all: CardReading[];
}

/** A reading taken by hand in the field (QGIS "Field Readings" layer). */
export interface FieldReading {
  measure: string | null;
  value: number | string | null;
  unit: string | null;
  time: string | null;
  by: string | null;
  note: string | null;
}

/** The parts of a station with a problem, worst first: the speech bubble over it. */
export interface ProblemPart {
  group: MonGroup;
  state: MonState;
}

/** The live, twin-derived fields of a station (replaced by every status update). */
export interface StationMonitor {
  status: string | null;
  alarm: string | null;
  state: MonState | null;
  headline: string | null;
  issues: string[];
  data: DataHealth | null;
  standby: boolean;
  problems: ProblemPart[];
  groups: CardGroup[];
  action: string | null;
  affects: string | null;
  /** when the state last changed */
  since: string | null;
  /** pumping around the storage tank: the tank is out of service, or its inlet is closed (lib/monitor/status.ts) */
  bypass?: "tank-out" | "inlet-closed" | null;
}

export interface Facility extends StationMonitor {
  uid: string;
  name: string;
  lon: number;
  lat: number;
  system: string | null;
  color: string;
  barangay: string | null;
  municipality: string | null;
  twin_id: string | null;
  notes: string | null;
  roles: Role[];
  alerts: number;
  alert_slot: number | null;
  bgy: string | null;
  kind: SiteKind;
  fieldReadings: FieldReading[];
}

export interface PipeProps {
  uid: string;
  name: string | null;
  class: PipeClass;
  color: string;
  band: BandKey | null;
  status: string | null;
  diameter: number | null;
  material: string | null;
  year: number | null;
  length: number | null;
  /** name of the nearest DPP (the pipe shows its pressure band) */
  dpp: string | null;
  /** twin id of that DPP, added by import-gis by matching dpp to the gauges' names */
  dpp_twin_id: string | null;
  /** the station that feeds it (by name) */
  supply: string | null;
  bgy: string | null;
  twin_id: string | null;
  alarm: string | null;
  /** what to do about a reported problem */
  action?: string | null;
}

export interface MeterProps {
  uid: string;
  name: string;
  type: MeterType;
  psi: number | null;
  flow: number | null;
  chlorine: number | null;
  time: string | null;
  band: BandKey | null;
  band_color: string | null;
  alarm: string | null;
  twin_id: string | null;
  status: string | null;
  bgy: string | null;
  state: MonState | null;
  headline: string | null;
  data: DataHealth | null;
  action: string | null;
  affects: string | null;
  fieldReadings: FieldReading[];
  /** the dial SVGs of a DPP, as exported (the page redraws them from live readings) */
  gauge?: string;
  gaugeHealth?: string;
}

export interface ValveProps {
  name: string | null;
  type: string | null;
  open: boolean;
  bgy: string | null;
}

export interface ZoneProps {
  name: string | null;
  color: string;
}

export interface BgyAreaProps {
  id: string;
  name: string;
  town: string | null;
  status: BgyStatusKey;
  label: string;
  rank: number;
  color: string;
  psi: number | null;
  time: string | null;
  km: number | null;
  facilities: number | null;
  alerts: number | null;
  stations: string | null;
  systems: string | null;
  /** the DPPs whose readings colour this barangay's pipes */
  dmas: string | null;
  meters: number | null;
  valves: number | null;
  /** monitor state; null when not served */
  state: MonState | null;
  headline: string | null;
  /** one of 4 soft colours, neighbours never alike */
  pastel: number | null;
}

export type Area = Polygon | MultiPolygon;
export type PipeFeature = Feature<LineString | MultiLineString, PipeProps>;
export type MeterFeature = Feature<Point, MeterProps>;
export type BgyAreaFeature = Feature<Area, BgyAreaProps>;

export interface Band { key: BandKey; color: string; label: string }
export interface BgyStatusDef { key: BgyStatusKey; label: string; color: string }
export interface BarangayName { name: string; town: string | null; lon: number; lat: number }

export interface ReliefImage {
  id: string;
  /** file name in public/gis/ */
  url: string;
  minzoom: number | null;
  maxzoom: number | null;
  /** top-left, top-right, bottom-right, bottom-left */
  corners: [number, number][];
}

/** The monitor's look: state colours, labels, icons (SVG markup), views and palette. */
export interface MonitorLook {
  status: { state: MonState; text: string };
  colours: Record<MonState, string>;
  labels: Record<MonState, string>;
  rank: MonState[];
  badges: Record<MonState, string>;
  groupIcons: Record<MonGroup, string>;
  views: string[];
  sites: Record<string, string>;
  siteLabels: Record<string, string>;
  palette: {
    ink: string; text: string; land: string; sea: string; served: string; main: string; branch: string;
    tints: Record<"ok" | "attention" | "down" | "nodata", string>; border: string;
    pastels: Record<string, string>; servedLine: string; bgyName: string;
  };
  relief: ReliefImage[];
}

/** Lookup tables and small layers: public/gis/meta.json */
export interface GisMeta {
  title: string;
  bounds: [number, number, number, number];
  minDischargePsi: number;
  staleHours: number;
  bands: Band[];
  bgyStatus: BgyStatusDef[];
  roleTitles: Record<Role, string>;
  meterLabels: Record<string, string>;
  pipeLabels: Record<string, string>;
  barangays: BarangayName[];
  /** field readings with a location (where = what they were taken at) */
  fieldReadings: (FieldReading & { lon: number; lat: number; where: string | null })[];
  monitor: MonitorLook;
}

export interface GisData {
  meta: GisMeta;
  facilities: Facility[];
  pipes: FeatureCollection<LineString | MultiLineString, PipeProps>;
  meters: FeatureCollection<Point, MeterProps>;
  valves: FeatureCollection<Point, ValveProps>;
  zones: FeatureCollection<Area, ZoneProps>;
  bgyAreas: FeatureCollection<Area, BgyAreaProps>;
}

/** The files in public/gis/, one per GisData key. */
export const GIS_FILES = {
  meta: "meta.json",
  facilities: "facilities.json",
  pipes: "pipes.json",
  meters: "meters.json",
  valves: "valves.json",
  zones: "zones.json",
  bgyAreas: "bgyAreas.json",
} as const satisfies Record<keyof GisData, string>;

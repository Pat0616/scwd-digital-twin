// The Sorsogon Water Monitor page: a port of the QGIS plugin's monitor_template.html (same look, wording, zoom
// tiers, views, barangay focus and search). The static GIS comes from /gis/*.json (npm run import-gis); the live
// status comes from the server's Server-Sent Events stream (/api/status/stream) and is merged in place by twin id.

import maplibregl from "maplibre-gl";
import type { GeoJSONSource, Map as MlMap, Marker } from "maplibre-gl";
import type {
  BgyAreaProps, Facility, GisData, MeterProps, MonState, PipeFeature,
} from "@/lib/gis/types";
import { GROUPS, slotOf } from "@/lib/monitor/status";
import type { TwinDetail } from "@/lib/status/detail";
import type { LiveResponse } from "@/lib/status/types";
import { gaugeSvg } from "./gauge";
import { startScada } from "./scada";
import type { Alarm } from "@/lib/scada/types";

type Gauge = MeterProps & { lon: number; lat: number };
type Bgy = BgyAreaProps;
type Row = { st: MonState; kind: string; name: string; text: string | null; affects?: string | null; action?: string | null; when: string; open: () => void };
/** A station's detail tabs: the plain summary, every part of its equipment, every live reading. */
type StationTab = "overview" | "equipment" | "readings";
type Current =
  | { kind: "station"; uid: string; tab: StationTab }
  | { kind: "gauge"; uid: string }
  | { kind: "pipe"; uid: string }
  | { kind: "focus"; id: string }
  | null;

const CITY_BOUNDS: [[number, number], [number, number]] = [[123.93, 12.925], [124.105, 13.055]];
const WAITING = "Waiting for the digital twin…";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const num = (v: number | null | undefined, d = 0) => v == null ? "—" : Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
function age(t: string | null | undefined): string {
  if (!t) return "";
  const h = (Date.now() - new Date(t).getTime()) / 3.6e6;
  if (h < 1 / 60) return "just now";
  if (h < 1) return `${Math.floor(h * 60)} min ago`;
  if (h < 48) return `${Math.round(h)} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
const timeOfDay = (t: string | null | undefined) => (t ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");

// ---- equipment specifications: a twin property as people read it ("rated_discharge_lps": "Rated discharge" "8 L/s")
const MODEL_NAMES: Record<string, string> = {
  WaterSource: "Water source (well)", SubmersiblePump: "Submersible pump", VFD: "Pump drive (VFD)", DischargePipe: "Discharge pipe",
  Chlorinator: "Chlorinator", ChlorinatorPump: "Chlorine dosing pump", ChlorineTank: "Chlorine tank", InletValve: "Inlet valve",
  StorageTank: "Storage tank", OutletValve: "Outlet valve", OutletPipe: "Outlet pipe", GridConnection: "Grid connection",
  Generator: "Generator", TransferSwitch: "Power transfer switch", TelemetryUnit: "Telemetry unit", BulkSupplyPoint: "Bulk supply point",
  PumpingStation: "Pumping station", DPP: "Designated Pressure Point", FarPointSite: "Far-point chlorine site",
};
const UNIT_SUFFIX: [RegExp, string][] = [
  [/_lps$/, "L/s"], [/_lph$/, "L/h"], [/_m3_per_day$/, "m³/day"], [/_m3$/, "m³"], [/_hp$/, "hp"], [/_kw$/, "kW"], [/_kva$/, "kVA"],
  [/_pct$/, "%"], [/_psi$/, "psi"], [/_mm$/, "mm"], [/_m$/, "m"], [/_v$/, "V"], [/_a$/, "A"], [/_hz$/, "Hz"], [/_l$/, "L"],
  [/_hours?$/, "h"], [/_ppm$/, "ppm"], [/_kg$/, "kg"],
];
const SPEC_HIDE = new Set(["spec_source", "latitude", "longitude", "station_status"]);
function specLabel(key: string): string {
  let k = key;
  for (const [re] of UNIT_SUFFIX) k = k.replace(re, "");
  const s = k.replace(/_/g, " ").replace(/\bno\b/, "no.").replace(/\bpct\b/, "%").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function specValue(key: string, v: string | number | boolean): string {
  if (typeof v === "boolean") return v ? "Yes" : "No";
  const unit = UNIT_SUFFIX.find(([re]) => re.test(key))?.[1];
  const text = typeof v === "number" ? v.toLocaleString() : v.replace(/_/g, " ");
  return unit ? (unit === "%" ? `${text}%` : `${text} ${unit}`) : text;
}
const affectsText = (a: string | null | undefined, most = 3) => {
  const l = (a || "").split(", ").filter(Boolean);
  return l.slice(0, most).join(", ") + (l.length > most ? ` +${l.length - most} more` : "");
};
function bbox(g: { coordinates: unknown }): [[number, number], [number, number]] {
  let a = [180, 90, -180, -90] as [number, number, number, number];
  const walk = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === "number") a = [Math.min(a[0], c[0]), Math.min(a[1], c[1] as number), Math.max(a[2], c[0]), Math.max(a[3], c[1] as number)];
    else if (Array.isArray(c)) c.forEach(walk);
  };
  walk(g.coordinates);
  return [[a[0], a[1]], [a[2], a[3]]];
}

type Extent = [[number, number], [number, number]];
/** An area layer of the QGIS project (public/gis/*.json, from npm run import-background). */
export type AreaData = GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon>;
/** The QGIS project's background layers (no online basemap). */
export interface Background {
  mask: AreaData;
  municipalities: AreaData;
  municipalityLabels: GeoJSON.FeatureCollection<GeoJSON.Point>;
  barangays: AreaData;
  barangayLabels: GeoJSON.FeatureCollection<GeoJSON.Point>;
  streets: GeoJSON.FeatureCollection<GeoJSON.LineString | GeoJSON.MultiLineString>;
  /** TRIAL: OpenStreetMap roads of the rest of the province (streets covers Sorsogon City only) */
  provinceRoads?: GeoJSON.FeatureCollection<GeoJSON.LineString>;
}
const PROVINCE_PAD = 0.02;  // degrees (about 2 km) the map may show past the province's edge

function bboxOfAll(fc: AreaData): Extent {
  const boxes = fc.features.map((f) => bbox(f.geometry));
  return [[Math.min(...boxes.map((b) => b[0][0])), Math.min(...boxes.map((b) => b[0][1]))],
    [Math.max(...boxes.map((b) => b[1][0])), Math.max(...boxes.map((b) => b[1][1]))]];
}

/** The limits the map is held to: the province plus PROVINCE_PAD, widened (or heightened) to the screen's shape, so
 * the whole province still fits on a screen of another shape (scwd-frontend's lockedBounds). */
function lockedBounds([[x0, y0], [x1, y1]]: Extent, el: HTMLElement): Extent {
  const aspect = Math.max(el.clientWidth, 1) / Math.max(el.clientHeight, 1);
  const k = Math.cos((((y0 + y1) / 2) * Math.PI) / 180);
  let w = (x1 - x0 + 2 * PROVINCE_PAD) * k, h = y1 - y0 + 2 * PROVINCE_PAD;
  if (w / h < aspect) w = h * aspect; else h = w / aspect;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return [[cx - w / k / 2, cy - h / 2], [cx + w / k / 2, cy + h / 2]];
}

/** A box around the area with every part of it (its islands too) cut out as a hole: QGIS's inverted polygon fill. */
function outsideMask(fc: AreaData): GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon> {
  const [[x0, y0], [x1, y1]] = bboxOfAll(fc), m = 5;
  const outer: GeoJSON.Position[] = [[x0 - m, y0 - m], [x1 + m, y0 - m], [x1 + m, y1 + m], [x0 - m, y1 + m], [x0 - m, y0 - m]];
  const parts = fc.features.flatMap((f) => (f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates));
  const clockwise = (r: GeoJSON.Position[]) => r.reduce((a, p, i) => { const q = r[(i + 1) % r.length]!; return a + (q[0]! - p[0]!) * (q[1]! + p[1]!); }, 0) > 0;
  const holes = parts.map((poly) => poly[0]!).map((r) => (clockwise(r) ? r : [...r].reverse()));
  // the area's own holes (e.g. Sorsogon Bay inside the province's extent) are outside it too: filled as well
  const inner = parts.flatMap((poly) => poly.slice(1)).map((r) => [clockwise(r) ? [...r].reverse() : r]);
  return { type: "FeatureCollection", features: [
    { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [outer, ...holes] } },
    ...(inner.length ? [{ type: "Feature" as const, properties: {}, geometry: { type: "MultiPolygon" as const, coordinates: inner } }] : []),
  ] };
}

export function startMonitor(root: HTMLElement, gis: GisData, bg: Background | null, onReady?: () => void): () => void {
  const $ = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const MON = gis.meta.monitor, COL = MON.colours as Record<string, string>, LBL = MON.labels as Record<string, string>;
  const RANK: Record<string, number> = Object.fromEntries(MON.rank.map((s, i) => [s, i]));
  const P = MON.palette;
  const badge = (st: string | null | undefined, cls = "b") => `<span class="badge ${cls}">${(MON.badges as Record<string, string>)[st ?? ""] || MON.badges.nodata}</span>`;
  const icon = (g: string) => `<span class="chip">${(MON.groupIcons as Record<string, string>)[g] ?? ""}</span>`;
  // state colours as text: bright on the navy sidebar, the QGIS ones on the light map
  const textCol = (st: string | null | undefined) => ["ok", "attention", "down", "nodata", "notwin"].includes(st ?? "") ? `var(--${st}-text)` : "var(--text)";
  const mapCol = (st: string | null | undefined) => st === "attention" ? "#b45309" : (COL[st ?? ""] || "#475569");
  const mapEl = $("#map"), side = $("#side"), detail = $("#detail");

  // ---------------------------------------------------------------- data (live fields blanked until the twin answers)
  const stations: Facility[] = gis.facilities.map((f) => ({ ...f }));
  const gauges: Gauge[] = gis.meters.features.map((f) => ({ ...f.properties, lon: f.geometry.coordinates[0]!, lat: f.geometry.coordinates[1]! }));
  const pipes = { ...gis.pipes, features: gis.pipes.features.map((f) => ({ ...f, properties: { ...f.properties } })) };
  const areas = { ...gis.bgyAreas, features: gis.bgyAreas.features.map((f) => ({ ...f, properties: { ...f.properties } })) };
  let city: { state: MonState | "waiting"; text: string } = { state: "waiting", text: "Connecting to the digital twin…" };
  for (const f of stations) if (f.twin_id)
    Object.assign(f, { state: "nodata", headline: WAITING, issues: [], groups: [], problems: [], action: null, affects: null, data: "none", since: null });
  for (const g of gauges) if (g.twin_id)
    Object.assign(g, { state: "nodata", headline: WAITING, psi: null, chlorine: null, time: null, action: null, affects: null, data: "none" });
  for (const f of pipes.features) if (f.properties.twin_id) Object.assign(f.properties, { alarm: null, action: null });
  for (const f of areas.features) if (f.properties.state) Object.assign(f.properties, { state: "nodata", headline: WAITING });

  const twinStations = () => stations.filter((f) => f.state && f.state !== "notwin");
  const twinGauges = () => gauges.filter((g) => g.twin_id);
  const bgys = () => areas.features.map((f) => f.properties).filter((b) => b.state);

  // ---------------------------------------------------------------- header
  let badgeText = "Connecting to the digital twin…", live: "wait" | "live" | "error" = "wait";
  function renderHeader() {
    const LIGHT: Record<string, string> = { ok: "#4ade80", attention: "#fbbf24", down: "#f87171", waiting: "#94a3b8" };
    $("#status").innerHTML = `<i style="background:${LIGHT[city.state] || LIGHT.attention}"></i>${esc(city.text)}`;
    $("#updated").textContent = badgeText;
    $(".top .live").className = `live ${live}`;
  }
  function todo(x: { action?: string | null; affects?: string | null }) {
    if (!x.action && !x.affects) return "";
    return `<div class="todo">${x.affects ? `<div class="k">AFFECTS</div><div>${esc(x.affects)}</div>` : ""}` +
      (x.action ? `<div class="k" style="margin-top:4px">WHAT TO DO</div><div class="act">→ ${esc(x.action)}</div>` : "") + `</div>`;
  }

  // ---------------------------------------------------------------- search: a barangay, station or pressure point by name
  type Place = { label: string; open: () => void };
  let places: Place[] = [];
  function renderPlaces() {
    places = [];
    for (const b of bgys()) places.push({ label: `${b.name} (barangay)`, open: () => focusBarangay(b.id) });
    const ts = twinStations();
    for (const f of [...ts, ...stations.filter((s) => !ts.includes(s))]) places.push({ label: `${f.name} (station)`, open: () => openStation(f.uid, true) });
    for (const g of twinGauges()) places.push({ label: `${g.name} (${g.type === "pressure_logger" ? "pressure point" : "chlorine check"})`, open: () => openGauge(g.uid, true) });
    $("#places").innerHTML = places.map((p) => `<option value="${esc(p.label)}"></option>`).join("");
  }
  const searchBox = $<HTMLInputElement>("#search");
  function findPlace(text: string) {
    const t = (text || "").trim().toLowerCase();
    if (!t) return;
    const hit = places.find((p) => p.label.toLowerCase() === t) || places.find((p) => p.label.toLowerCase().startsWith(t)) || places.find((p) => p.label.toLowerCase().includes(t));
    searchBox.classList.toggle("miss", !hit);
    if (hit) { hit.open(); searchBox.value = ""; }
  }
  searchBox.onchange = () => findPlace(searchBox.value);
  searchBox.onkeydown = (e) => { if (e.key === "Enter") findPlace(searchBox.value); };

  // ---------------------------------------------------------------- summary cards + attention list
  let filter: string | null = null;
  const count = (items: { state?: string | null }[]) => { const c: Record<string, number> = {}; for (const i of items) c[i.state ?? ""] = (c[i.state ?? ""] || 0) + 1; return c; };
  function renderCards() {
    const ts = twinStations();
    const defs: [string, string, Record<string, number>, number][] = [["stations", "Stations", count(ts), stations.length - ts.length],
      ["gauges", "Pressure & chlorine", count(twinGauges()), 0], ["barangays", "Barangays served", count(bgys()), 0]];
    $("#cards").innerHTML = defs.map(([k, t, c, extra]) => {
      const bad = ([["down", "not working"], ["attention", "need attention"], ["nodata", "no data"]] as const)
        .filter(([s]) => c[s]).map(([s, w]) => `<div style="color:${textCol(s)}">${c[s]} ${w}</div>`).join("");
      return `<button class="card ${filter === k ? "on" : ""}" data-k="${k}"><div class="t">${t}</div>` +
        `<div class="big">${c.ok || 0} <small>OK</small></div><div class="bad">${bad || '<span style="color:var(--muted)">no problems</span>'}` +
        `${extra ? `<div style="color:var(--faint)">+${extra} not in twin yet</div>` : ""}</div></button>`;
    }).join("");
    root.querySelectorAll<HTMLElement>(".card").forEach((b) => b.onclick = () => { filter = filter === b.dataset.k ? null : b.dataset.k!; renderCards(); renderAttention(); });
  }
  function attentionRows(): Row[] {
    const rows: Row[] = [];
    const bad = (s: string | null | undefined): s is MonState => s === "down" || s === "attention" || s === "nodata";
    for (const f of twinStations()) if (bad(f.state) && f.headline !== WAITING)
      rows.push({ st: f.state, kind: "stations", name: f.name, text: f.headline, affects: f.affects, action: f.action,
        when: f.since ? `since ${age(f.since)}` : "", open: () => openStation(f.uid, true) });
    for (const g of twinGauges()) if (bad(g.state) && g.headline !== WAITING)
      rows.push({ st: g.state, kind: "gauges", name: g.name, text: g.headline, affects: g.affects, action: g.action,
        when: g.time ? `reported ${age(g.time)}` : "", open: () => openGauge(g.uid, true) });
    const seen = new Set<string | null>();
    for (const p of pipes.features) if (p.properties.alarm && !seen.has(p.properties.twin_id)) {
      seen.add(p.properties.twin_id);
      const where = (p.properties.twin_id || "").replace("-distribution", "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      rows.push({ st: "attention", kind: "barangays", name: `Pipes in ${where}`, text: `Reported: ${p.properties.alarm}`,
        affects: where, action: p.properties.action, when: "", open: () => openPipe(p.properties.uid) });
    }
    if (filter === "barangays") for (const b of bgys()) if (b.state === "down") rows.push({ st: "down", kind: "barangays", name: b.name, text: b.headline, when: "", open: () => focusBarangay(b.id) });
    const n = (r: Row) => (r.affects || "").split(", ").filter(Boolean).length;
    rows.sort((a, b) => (RANK[a.st]! - RANK[b.st]!) || (n(b) - n(a)) || a.name.localeCompare(b.name));
    return filter ? rows.filter((r) => r.kind === filter) : rows;
  }
  function renderAttention() {
    const rows = attentionRows();
    $("#attTitle").textContent = `Needs attention (${rows.length})`;
    const el = $("#attention");
    el.innerHTML = rows.length ? rows.map((r, i) => {
      const who = [r.affects ? `Affects ${affectsText(r.affects)}` : "", r.when].filter(Boolean).join(" · ");
      return `<div class="row" data-i="${i}">${badge(r.st)}<div><div class="n">${esc(r.name)}</div>` +
        `<div class="h" style="color:${textCol(r.st)}">${esc(r.text)}</div>` + (who ? `<div class="w">${esc(who)}</div>` : "") +
        (r.action ? `<div class="a">→ ${esc(r.action)}</div>` : "") + `</div></div>`;
    }).join("")
      : live === "live" ? `<div class="row">${badge("ok")}<div><div class="n">Everything is working</div><div class="h">No problems reported</div></div></div>`
      : `<div class="row">${badge("nodata")}<div><div class="n">${live === "error" ? "Digital twin unreachable" : "Connecting to the digital twin"}</div><div class="h">${live === "error" ? "Showing the last status received" : "Live status will show here"}</div></div></div>`;
    el.querySelectorAll<HTMLElement>(".row[data-i]").forEach((d) => d.onclick = () => rows[+d.dataset.i!]!.open());
  }
  function renderCitySummary() {
    const c = count(twinStations());
    // as the QGIS project's Sorsogon City label in the province view (monitor_style.style_municipalities)
    const text = `SCWD water: ${c.ok || 0} working` + (c.down ? ` · ${c.down} not working` : "") + (c.attention ? ` · ${c.attention} need attention` : "");
    const colour = c.down ? COL.down! : c.attention ? "#b45309" : COL.ok!;
    if (map.getLayer("muni-summary")) {
      map.setLayoutProperty("muni-summary", "text-field", lastLive ? text : "");
      map.setPaintProperty("muni-summary", "text-color", colour);
    }
  }

  // ---------------------------------------------------------------- details
  let current: Current = null;
  let focusId: string | null = null;
  function showDetail(html: string) {
    const back = focusId && !html.includes("exitfocus")
      ? `<button class="back" data-act="backfocus">← Back to ${esc(bgys().find((x) => x.id === focusId)?.name || "barangay")}</button>`
      : html.includes("exitfocus") ? "" : `<button class="back" data-act="close">← All of Sorsogon City</button>`;
    detail.innerHTML = back + html;
    side.classList.add("showing");
  }
  function closeDetail() { side.classList.remove("showing"); current = null; select(null); }
  function head(title: string, st: string | null | undefined, hl: string | null | undefined, where?: string) {
    return `<div class="head">${badge(st)}<div><h2>${esc(title)}</h2><div class="hl" style="color:${textCol(st)}">${esc(hl || LBL[st ?? ""] || "")}</div>${where ? `<div class="where">${esc(where)}</div>` : ""}</div></div>`;
  }
  function tiles(list: Facility["groups"][number]["all"]) {
    if (!list.length) return "";
    return `<div class="tiles">` + list.map((s) => {
      const lim = [s.min != null ? `min ${s.min}` : "", s.max != null ? `max ${s.max}` : ""].filter(Boolean).join(" · ");
      // a numeric reading opens its trend in the faceplate
      const trend = s.twin_id && s.property && /\d/.test(s.value) ? ` data-act="trend" data-key="${esc(`${s.twin_id}|${s.property}`)}"` : "";
      return `<div class="tile ${s.alarm || s.offline ? "alarm" : ""} ${trend ? "trendable" : ""}"${trend} title="${esc(s.alarm || (trend ? "Show its trend" : ""))}"><div class="tn" title="${esc(s.name)}">${esc(s.name)}</div><div class="tv">${esc(s.value)}</div>` +
        (s.pct != null ? `<div class="bar"><i style="width:${Math.max(0, Math.min(100, s.pct))}%"></i></div>` : "") +
        `<div class="tm">${esc([lim, s.offline ? "sensor offline" : age(s.time)].filter(Boolean).join(" · "))}</div></div>`;
    }).join("") + `</div>`;
  }
  function fieldTable(rows: Facility["fieldReadings"] | undefined) {
    if (!rows || !rows.length) return "";
    return `<div class="note"><b>Field readings</b><table class="fr">` + rows.map((r) => `<tr><td>${esc(r.measure)}</td><td><b>${esc(r.value ?? "—")} ${esc(r.unit || "")}</b></td><td style="color:var(--faint)">${esc(age(r.time))} · ${esc(r.by || "")}</td></tr>`).join("") + `</table></div>`;
  }
  function specsHtml(props: Record<string, string | number | boolean>) {
    const rows = Object.entries(props).filter(([k]) => !SPEC_HIDE.has(k) && k !== "issue");
    const src = props.spec_source && props.spec_source !== "mock" ? props.spec_source : null;   // "mock": no real source
    if (!rows.length && !src) return "";
    return `<dl class="specs">` + rows.map(([k, v]) => `<dt>${esc(specLabel(k))}</dt><dd>${esc(specValue(k, v))}</dd>`).join("") +
      (src ? `<div class="src">Source: ${esc(src)}</div>` : "") + `</dl>`;
  }

  // ---- the twin's details (parts, specifications, device info) from /api/twin/[id], re-read on every live status
  const details = new Map<string, { at: string | null; data: TwinDetail | null; loading: boolean }>();
  /** The twin's details: the latest copy (possibly from the previous status while a new one loads), undefined
   * before the first one arrives, null when it could not be read. */
  function twinDetail(id: string): TwinDetail | null | undefined {
    const at = lastLive?.fetchedAt ?? null;
    const d = details.get(id);
    if ((!d || d.at !== at) && !d?.loading) {
      details.set(id, { at: d?.at ?? null, data: d?.data ?? null, loading: true });
      fetch(`/api/twin/${encodeURIComponent(id)}`)
        .then((r) => (r.ok ? (r.json() as Promise<TwinDetail>) : null))
        .catch(() => null)
        .then((data) => {
          details.set(id, { at, data, loading: false });
          if ((current?.kind === "station" && current.tab === "equipment") || current?.kind === "gauge") rerenderDetail();
        });
      if (!d) return undefined;
    }
    return d ? d.data : undefined;
  }

  // ---- stations: Overview (plain words), Equipment (every part, working or not), Readings (every live reading)
  const SHORT: Record<string, string> = { source: "Source", treatment: "Treat", pumping: "Pump", vfd: "VFD", storage: "Tank", grid: "Grid", generator: "Gen" };
  const WORD: Record<string, string> = { ok: "Working", attention: "Check", down: "Not working", nodata: "No data" };
  const openParts = new Set<string>(), closedParts = new Set<string>();
  let scrollToGroup: string | null = null;

  function openStation(uid: string, fly: boolean, tab: StationTab = "overview") {
    const f = stations.find((s) => s.uid === uid);
    if (!f) return;
    current = { kind: "station", uid, tab };
    select(uid);
    if (fly) map.flyTo({ center: [f.lon, f.lat], zoom: 16 });
    const where = f.barangay ? `${f.barangay}, Sorsogon City` : "";
    if (f.state === "notwin" || !f.twin_id) {
      showDetail(head(f.name, "notwin", "Not in the digital twin yet", where) +
        `<div class="note">This station is on the SCWD official map but not in the digital twin yet, so there are no live readings. Add it to Azure Digital Twins to monitor it here.</div>` +
        (f.notes ? `<div class="note">${esc(f.notes)}</div>` : ""));
      return;
    }
    let html = head(f.name, f.state, (f.headline || "").split(" (+")[0], where) +
      `<button class="fpbtn" data-act="faceplate" data-uid="${esc(f.uid)}">Open faceplate · schematic and trends</button>` + todo(f);
    // the seven equipment groups at a glance
    const byGroup = new Map(f.groups.map((g) => [g.group, g]));
    html += `<div class="strip">` + GROUPS.map(([g, title]) => {
      const cg = byGroup.get(g);
      return cg ? `<button data-act="group" data-uid="${esc(f.uid)}" data-g="${g}" title="${esc(title)}: ${esc(LBL[cg.state] || "")}">${icon(g)}<i style="background:${COL[cg.state] || COL.nodata}"></i>${SHORT[g]}</button>`
        : `<button class="none" disabled title="${esc(title)}: none at this site">${icon(g)}${SHORT[g]}</button>`;
    }).join("") + `</div>`;
    const nReadings = f.groups.reduce((n, g) => n + g.all.length, 0);
    const nParts = f.groups.reduce((n, g) => n + g.parts.length, 0);
    html += `<div class="tabs">` + ([["overview", "Overview", ""], ["equipment", "Equipment", nParts || ""], ["readings", "Readings", nReadings]] as const)
      .map(([k, t, n]) => `<button class="${tab === k ? "on" : ""}" data-act="tab" data-tab="${k}" data-uid="${esc(f.uid)}">${t}${n !== "" ? `<em>${n}</em>` : ""}</button>`).join("") + `</div>`;
    if (tab === "overview") {
      if ((f.issues || []).length > 1) html += `<div class="issues"><b>Needs attention</b>${f.issues.map((i) => "• " + esc(i)).join("<br>")}</div>`;
      for (const g of f.groups)
        html += `<div class="group ${g.state}"><div class="gh">${icon(g.group)}<span class="gt">${esc(g.title)}</span><span class="pill ${g.state}">${WORD[g.state] || ""}</span></div>` +
          (g.issues.length ? `<div class="gi">${g.issues.map(esc).join("; ")}</div>` : "") + tiles(g.key) + `</div>`;
      html += fieldTable(f.fieldReadings);
    } else if (tab === "readings") {
      for (const g of f.groups) if (g.all.length)
        html += `<div class="group ${g.state}"><div class="gh">${icon(g.group)}<span class="gt">${esc(g.title)}</span><span class="gc">${g.all.length}</span><span class="pill ${g.state}">${WORD[g.state] || ""}</span></div>` +
          tiles(g.all) + `</div>`;
      if (!nReadings) html += `<div class="note">This site reports no live readings yet.</div>`;
    } else html += equipmentHtml(f);
    html += `<div class="twin">Twin id: ${esc(f.twin_id || "—")}${lastLive ? ` · updated ${esc(timeOfDay(lastLive.fetchedAt))}` : ""}</div>`;
    showDetail(html);
    if (tab === "equipment" && scrollToGroup) {
      const el = detail.querySelector(`#grp-${scrollToGroup}`);
      if (el) { el.scrollIntoView({ block: "start", behavior: "smooth" }); scrollToGroup = null; }
    }
  }

  function equipmentHtml(f: Facility): string {
    const d = twinDetail(f.twin_id!);
    if (d === undefined) return `<div class="loading">Loading the equipment from the digital twin…</div>`;
    if (d === null) return `<div class="note">The equipment details could not be read from the digital twin. They will load with the next update.</div>`;
    type Part = TwinDetail["parts"][number];
    // a bulk supply point has no parts: the site itself is its one piece of equipment
    const parts: Part[] = d.parts.length ? d.parts
      : [{ id: d.id, model: d.model, name: d.name, role: null, props: d.props, status: f.status === "offline" ? "offline" : "operational", alarm: null }];
    let html = `<div class="tools"><a data-act="expand" data-uid="${esc(f.uid)}">Expand all</a><a data-act="collapse" data-uid="${esc(f.uid)}">Collapse all</a></div>`;
    if (d.parts.length) {
      const sp = specsHtml(d.props);
      html += `<div class="group"><div class="gh"><span class="chip">${MON.sites[f.kind || "station"] ?? ""}</span><span class="gt">${esc(MODEL_NAMES[d.model] || d.model)}</span>` +
        `<span class="pill ${f.status === "offline" ? "down" : "ok"}">${f.status === "offline" ? "Down" : f.standby ? "Standby" : "Operating"}</span></div>` +
        (typeof d.props.issue === "string" ? `<div class="gi" style="color:var(--down-text)">${esc(d.props.issue)}</div>` : "") +
        (sp || `<div class="muted" style="margin-top:6px">No station specifications in the twin.</div>`) + `</div>`;
    }
    const groupState = new Map(f.groups.map((g) => [g.group as string, g.state]));
    const sections: [string, string][] = [...GROUPS, ["other", "Other equipment"]];
    for (const [g, title] of sections) {
      const list = parts.filter((p) => (slotOf(p.model) ?? "other") === g);
      if (!list.length) continue;
      const st = groupState.get(g) ?? "ok";
      html += `<div class="group ${st}" id="grp-${g}"><div class="gh">${g === "other" ? `<span class="chip"></span>` : icon(g)}<span class="gt">${esc(title)}</span>` +
        `<span class="gc">${list.length} part${list.length > 1 ? "s" : ""}</span><span class="pill ${st}">${WORD[st] || ""}</span></div>`;
      for (const p of list) {
        const rs = d.readings.filter((r) => r.twin_id === p.id);
        const state = p.status === "offline" ? "down" : p.alarm ? "attention" : "ok";
        const open = openParts.has(p.id) || (state !== "ok" && !closedParts.has(p.id));
        const first = rs[0];
        const kv = first ? `${first.value}`.replace(/ lps$/, " L/s").replace(/ %$/, "%") : "";
        const sub = [MODEL_NAMES[p.model] || p.model, rs.length ? `${rs.length} reading${rs.length > 1 ? "s" : ""}` : "no live readings"].join(" · ");
        const tileList = rs.map((r) => ({
          name: r.name, value: r.value.replace(/ lps$/, " L/s").replace(/ %$/, "%"), alarm: r.alarm, offline: !r.online, time: r.time,
          unit: r.unit, pct: r.unit === "%" ? r.number : null, min: r.min, max: r.max, twin_id: r.twin_id, property: r.property,
        }));
        const sp = specsHtml(p.props);
        html += `<details class="part" data-id="${esc(p.id)}"${open ? " open" : ""}><summary>` +
          `<span class="dot" style="background:${textCol(state)};color:${textCol(state)}"></span>` +
          `<span class="pn"><b>${esc(p.name || MODEL_NAMES[p.model] || p.model)}</b><small>${esc(sub)}</small></span>` +
          (kv ? `<span class="kv" style="${state !== "ok" && first?.alarm ? "color:var(--down-text)" : ""}">${esc(kv)}</span>` : `<span class="pill ${state}">${state === "ok" ? "Working" : state === "down" ? "Not working" : "Check"}</span>`) +
          `<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="m9 6 6 6-6 6"/></svg></summary>` +
          `<div class="body">` + (p.alarm ? `<div class="alarmtxt">${esc(p.alarm)}</div>` : "") +
          (p.status === "offline" ? `<div class="alarmtxt">Not operational</div>` : "") +
          tiles(tileList) + (sp || `<div class="muted" style="margin-top:8px">No specifications in the twin.</div>`) +
          `<div class="twin" style="margin-top:8px">${esc(p.id)}</div></div></details>`;
      }
      html += `</div>`;
    }
    return html;
  }

  function openGauge(uid: string, fly: boolean) {
    const g = gauges.find((x) => x.uid === uid);
    if (!g) return;
    current = { kind: "gauge", uid };
    select(uid);
    if (fly) map.flyTo({ center: [g.lon, g.lat], zoom: 16 });
    const what = g.type === "pressure_logger" ? "Designated Pressure Point (DPP)" : "Far-point chlorine check";
    const range = g.type === "pressure_logger" ? "Safe range: at least <b>7 psi</b> (SCWD minimum). Below 3 psi means little or no water at the tap."
      : "Safe range: <b>0.3 – 1.5 ppm</b> free chlorine at the end of the line.";
    const value = g.type === "pressure_logger" ? (g.psi != null ? `${g.psi} psi` : "—") : (g.chlorine != null ? `${g.chlorine} ppm` : "—");
    const pic = g.type === "pressure_logger" ? `<span class="badge" style="width:64px;height:64px;flex:none">${gaugeSvg(g.psi, g.state && g.state !== "notwin" ? g.state : "nodata", COL)}</span>` : "";
    let html = head(g.name, g.state || "nodata", g.headline, what) +
      (g.twin_id ? `<button class="fpbtn" data-act="gfaceplate" data-uid="${esc(g.uid)}">Open faceplate · trend</button>` : "") + todo(g) +
      `<div class="note" style="display:flex;gap:14px;align-items:center">${pic}<div>Reading: <b style="font-size:15px">${esc(value)}</b><br>` +
      `${esc(age(g.time) || "no reading")}${g.status === "offline" ? " · sensor offline" : ""}<br>${range}</div></div>`;
    if (g.twin_id) {
      const d = twinDetail(g.twin_id);
      html += `<div class="sec">Device</div>` + (d === undefined ? `<div class="loading">Loading the device from the digital twin…</div>`
        : d ? `<div class="group">${specsHtml(d.props) || `<div class="muted">No device details in the twin.</div>`}</div>` : "");
    }
    html += fieldTable(g.fieldReadings) + `<div class="twin">Twin id: ${esc(g.twin_id || "—")}</div>`;
    showDetail(html);
  }
  function openPipe(uid: string) {
    const p = pipes.features.find((x) => x.properties.uid === uid);
    if (!p) return;
    current = { kind: "pipe", uid };
    const c = p.geometry.type === "LineString" ? p.geometry.coordinates : p.geometry.coordinates[0]!;
    map.flyTo({ center: c[Math.floor(c.length / 2)] as [number, number], zoom: 15.5 });
    const st = p.properties.alarm ? "attention" : "ok";
    showDetail(head(p.properties.name || "Pipe", st, p.properties.alarm ? `Reported: ${p.properties.alarm}` : "No problem reported", `${p.properties.diameter || "?"} mm ${p.properties.material || ""}`) +
      todo({ action: p.properties.action }) + `<div class="note">All pipes of this distribution line are marked with a red dash on the map until the twin reports the problem fixed.</div><div class="twin">Twin pipe: ${esc(p.properties.twin_id || "—")}</div>`);
  }

  // ---- barangay focus: click a barangay to isolate it (its pressure points, chlorine check and stations)
  function holes(geom: { type: string; coordinates: unknown }) {
    const polys = (geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates) as number[][][][];
    return polys.map((p) => p[0]!.slice().reverse());
  }
  function applyFocusClasses() {
    for (const { el, f: s } of stationMarkers) { el.classList.toggle("dim", !!focusId && s.bgy !== focusId); el.classList.toggle("focus", !!focusId && s.bgy === focusId); }
    for (const m of gaugeMarkers) {
      const inside = !!focusId && m.g.bgy === focusId;
      m.wrap.classList.toggle("dim", !!focusId && !inside);
      m.wrap.classList.toggle("focus", inside);
      const lab = m.wrap.querySelector<HTMLElement>(".glab");
      if (lab) lab.textContent = inside ? lab.dataset.focus! : lab.dataset.plain!;
    }
  }
  function focusBarangay(id: string, move = true) {
    const f = areas.features.find((x) => x.properties.id === id && x.properties.state);
    if (!f) return;
    focusId = id;
    current = { kind: "focus", id };
    (map.getSource("focusmask") as GeoJSONSource | undefined)?.setData({ type: "Feature", properties: {}, geometry: { type: "Polygon",
      coordinates: [[[100, -10], [150, -10], [150, 40], [100, 40], [100, -10]], ...holes(f.geometry)] } });
    if (map.getLayer("focus-line")) {
      map.setFilter("focus-line", ["==", ["get", "id"], id]);
      map.setFilter("bgy-name", ["==", ["get", "id"], id]);
      map.setFilter("bgy-name-city", ["==", ["get", "id"], id]);
    }
    applyFocusClasses();
    if (move) map.fitBounds(bbox(f.geometry), { padding: 70 });
    showDetail(focusHtml(f.properties));
    detail.querySelectorAll<HTMLElement>(".frow[data-k]").forEach((d) => d.onclick = () => {
      const [k, i] = d.dataset.k!.split(":");
      if (k === "s") openStation(i!, true); else openGauge(i!, true);
    });
  }
  function clearFocus() {
    if (!focusId) return;
    focusId = null;
    (map.getSource("focusmask") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: [] });
    map.setFilter("focus-line", ["==", ["get", "id"], "__none__"]);
    map.setFilter("bgy-name", ["==", ["get", "town"], "Sorsogon City"]);
    map.setFilter("bgy-name-city", ["==", ["get", "town"], "Sorsogon City"]);
    applyFocusClasses();
    map.fitBounds(CITY_BOUNDS);
    closeDetail();
  }
  function focusHtml(b: Bgy) {
    const st = stations.filter((s) => s.bgy === b.id).sort((a, c) => Number(a.state === "notwin") - Number(c.state === "notwin") || a.name.localeCompare(c.name));
    const gs = gauges.filter((g) => g.bgy === b.id);
    const dpps = gs.filter((g) => g.type === "pressure_logger").sort((a, c) => a.name.localeCompare(c.name));
    const chl = gs.filter((g) => g.type === "chlorine_point");
    const row = (k: string, pic: string, name: string, line: string | null, state: string, extra = "", cls = "") => `<div class="frow" data-k="${k}"><span class="pic ${cls}">${pic}</span>` +
      `<div><div class="n">${esc(name)}</div><div class="h" style="color:${textCol(state)}">${esc(line || "")}</div>${extra}</div></div>`;
    let html = `<button class="exitfocus" data-act="exitfocus">← Whole city</button>` + head(b.name, b.state, b.headline, "Barangay, Sorsogon City · in focus");
    html += `<div class="sec">PRESSURE POINTS (DPP)</div><div class="list">` + (dpps.length ? dpps.map((g) =>
      row(`g:${g.uid}`, gaugeSvg(g.psi, g.state || "nodata", COL), g.name, g.headline, g.state || "nodata",
        g.time ? `<div class="h" style="color:var(--faint)">${esc(age(g.time))}</div>` : "")).join("")
      : `<div class="frow"><div class="h">No pressure point in the digital twin for this barangay yet.</div></div>`) + `</div>`;
    if (chl.length) html += `<div class="sec">CHLORINE CHECK</div><div class="list">` + chl.map((g) =>
      row(`g:${g.uid}`, badge(g.state || "nodata"), g.name, g.headline, g.state || "nodata")).join("") + `</div>`;
    html += `<div class="sec">PUMPING STATIONS</div><div class="list">` + (st.length ? st.map((s) => {
      const twin = !!s.state && s.state !== "notwin";
      const pic = MON.sites[twin || s.kind !== "station" ? s.kind || "station" : "station-muted"] ?? "";
      const parts = (s.problems || []).length ? `<div class="parts">` + s.problems.map((q) => `<span class="chip">${MON.groupIcons[q.group]}<b>${MON.badges[q.state] || MON.badges.attention}</b></span>`).join("") + `</div>` : "";
      return row(`s:${s.uid}`, pic, s.name, twin ? s.headline : "Not in the digital twin yet", s.state || "nodata", parts, "site chip");
    }).join("") : `<div class="frow"><div class="h">No pumping station in this barangay; it is supplied through the network.</div></div>`) + `</div>`;
    html += `<div class="note">Lowest pressure now: <b>${b.psi != null ? num(b.psi, 1) + " psi" : "—"}</b><br>` +
      `Latest reading: <b>${esc(age(b.time) || "—")}</b><br>Pipes: <b>${num(b.km, 1)} km</b></div>` +
      `<div class="twin">Press Esc or “Whole city” to see all of Sorsogon City again.</div>`;
    return html;
  }
  function rerenderDetail() {
    const c = current;
    if (!c || !side.classList.contains("showing")) return;
    const scroll = side.querySelector(".scroll")!.scrollTop;
    if (c.kind === "station") openStation(c.uid, false, c.tab);
    else if (c.kind === "gauge") openGauge(c.uid, false);
    else if (c.kind === "pipe") { const keep = map.getCenter(); openPipe(c.uid); map.stop(); map.setCenter(keep); }
    else focusBarangay(c.id, false);
    side.querySelector(".scroll")!.scrollTop = scroll;
  }
  const onDetailClick = (e: MouseEvent) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!t) return;
    const act = t.dataset.act;
    if (act === "close") closeDetail();
    else if (act === "backfocus" && focusId) focusBarangay(focusId);
    else if (act === "exitfocus") clearFocus();
    else if (act === "tab") { side.querySelector(".scroll")!.scrollTop = 0; openStation(t.dataset.uid!, false, t.dataset.tab as StationTab); }
    else if (act === "group") { scrollToGroup = t.dataset.g!; openStation(t.dataset.uid!, false, "equipment"); }
    else if (act === "faceplate") scada.openFaceplate("station", t.dataset.uid!);
    else if (act === "gfaceplate") scada.openFaceplate("gauge", t.dataset.uid!);
    else if (act === "trend" && current?.kind === "station") scada.openFaceplate("station", current.uid, t.dataset.key);
    else if (act === "expand" || act === "collapse") {
      detail.querySelectorAll<HTMLDetailsElement>("details.part").forEach((el) => { el.open = act === "expand"; });
    }
  };
  detail.addEventListener("click", onDetailClick);
  // remember which parts were opened or closed, so a live update keeps the panel as the user left it
  const onToggle = (e: Event) => {
    const el = e.target as HTMLElement;
    if (!(el instanceof HTMLDetailsElement) || !el.dataset.id) return;
    const id = el.dataset.id;
    if (el.open) { openParts.add(id); closedParts.delete(id); } else { openParts.delete(id); closedParts.add(id); }
  };
  detail.addEventListener("toggle", onToggle, true);
  // "/" jumps to the search; Esc leaves a barangay focus, then closes the details
  const onKey = (e: KeyboardEvent) => {
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    if (e.key === "/" && !typing) { e.preventDefault(); searchBox.focus(); }
    else if (e.key === "Escape") {
      if (typing) searchBox.blur();
      else if (focusId) clearFocus();
      else if (side.classList.contains("showing")) closeDetail();
    }
  };
  document.addEventListener("keydown", onKey);

  // the selected station or gauge gets a cyan halo on the map
  let selUid: string | null = null;
  function select(uid: string | null) {
    selUid = uid;
    for (const { el, f } of stationMarkers) el.classList.toggle("sel", f.uid === uid);
    for (const m of gaugeMarkers) m.wrap.classList.toggle("sel", m.g.uid === uid);
  }

  // ---------------------------------------------------------------- map
  // The QGIS project's own picture, layer for layer (monitor_style.py), with no online basemap: from the bottom,
  // Outside Mask, Sorsogon Municipalities, Province relief, Municipality borders, Sorsogon Barangays, City relief,
  // Served Area, Streets, then the network. Zoom tiers as the project's scales: the province view below zoom 11
  // (PROVINCE_SCALE 1:150,000), the city view to 13 (STREET_TIER 1:25,000), the street view from there.
  const PX_PER_MM = 3.78, PX_PER_PT = 1.333;                 // QGIS sizes (96 dpi) as screen pixels
  const Z = { city: 11, bgyNames: 11.45, mid: 12, minor: 12.8, street: 13, streetNames: 14.6 };   // 1:100k, 60k, 30k, 6k
  const SEA = "#c9dceb", LAND = P.land, STREET = "#ffffff", STREET_EDGE = "#dcdfe3", MUNI_LINE = "#b8c2cf";
  // TRIAL (2026-11-15): the city view over the coloured relief (the province view's) instead of the washed one, with
  // a lighter served tint and outlined roads so the road map reads over it. false = back to the QGIS look.
  const CITY_COLOUR_RELIEF = true;
  const CITY_ROAD_EDGE = "#8f9aa8";                          // road outline over the coloured relief
  // held to Sorsogon (as scwd-frontend): it opens on the city, and can neither pan nor zoom out past the province
  const extent: Extent = bg ? bboxOfAll(bg.municipalities) : [[gis.meta.bounds[0], gis.meta.bounds[1]], [gis.meta.bounds[2], gis.meta.bounds[3]]];
  const style: maplibregl.StyleSpecification = {
    version: 8,
    glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",       // the label fonts only
    sources: {},
    // the QGIS canvas: white (it shows as a pale band between the coast and the Outside Mask's edge)
    layers: [{ id: "canvas", type: "background", paint: { "background-color": "#ffffff" } }],
  };
  const map: MlMap = new maplibregl.Map({ container: mapEl, style, bounds: CITY_BOUNDS, maxBounds: lockedBounds(extent, mapEl),
    renderWorldCopies: false, attributionControl: { compact: true, customAttribution: "Sorsogon Water Monitor (QGIS) · streets and roads © OpenStreetMap contributors" } });
  map.on("resize", () => map.setMaxBounds(lockedBounds(extent, mapEl)));
  // development only: lets a test browser check the map (marker positions, bounds)
  if (process.env.NODE_ENV !== "production") (window as unknown as { __monitorMap?: MlMap }).__monitorMap = map;
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");
  let view = MON.views[0]!;
  const WIDTH = ["match", ["get", "class"], "transmission", 3.2, "dist_main", 2.8, "dist_secondary", 1.4, "service", 1, 1.2];
  const BAND = ["match", ["get", "band"], "very_low", COL.down, "low", COL.attention, "ok", COL.ok, "high", "#7c3aed", "#b8c2cf"];
  const halo = { "text-halo-color": "rgba(255,255,255,0.92)" };
  let loaded = false;
  map.on("load", () => {
    loaded = true;
    const relief = (i: number) => {                        // 0: province relief, 1: city relief (washed light)
      const r = (MON.relief || [])[i];
      if (!r) return;
      map.addSource(r.id, { type: "image", url: `/gis/${r.url}`, coordinates: r.corners as [[number, number], [number, number], [number, number], [number, number]] });
      map.addLayer({ id: r.id, type: "raster", source: r.id, ...(r.minzoom != null ? { minzoom: r.minzoom } : {}), ...(r.maxzoom != null ? { maxzoom: r.maxzoom } : {}),
        paint: { "raster-opacity": 1, "raster-fade-duration": 0, "raster-resampling": "linear" } });
    };
    if (bg) {
      // Outside Mask: the sea colour everywhere outside the province's extent, with a thin grey edge
      map.addSource("mask", { type: "geojson", data: outsideMask(bg.mask) });
      map.addLayer({ id: "outside-mask", type: "fill", source: "mask", paint: { "fill-color": SEA, "fill-antialias": false } });
      map.addLayer({ id: "outside-edge", type: "line", source: "mask", paint: { "line-color": "#b8c2cf", "line-width": 0.4 * PX_PER_MM } });
      // Sorsogon Municipalities: the land of the whole province, its edge
      map.addSource("muni", { type: "geojson", data: bg.municipalities });
      map.addLayer({ id: "muni-land", type: "fill", source: "muni", paint: { "fill-color": LAND } });
      map.addLayer({ id: "muni-edge", type: "line", source: "muni", paint: { "line-color": MUNI_LINE, "line-width": 0.5 * PX_PER_MM } });
    }
    relief(0);                                             // Province relief (province view)
    if (bg) {
      // Municipality borders over the province relief (province view)
      map.addLayer({ id: "muni-borders", type: "line", source: "muni", maxzoom: Z.city, layout: { "line-join": "round" },
        paint: { "line-color": "#7c8899", "line-width": 0.5 * PX_PER_MM } });
      // Sorsogon Barangays: land with thin borders from the city view in
      map.addSource("barangays", { type: "geojson", data: bg.barangays });
      map.addLayer({ id: "bgy-land", type: "fill", source: "barangays", minzoom: Z.city, paint: { "fill-color": LAND } });
      map.addLayer({ id: "bgy-land-edge", type: "line", source: "barangays", minzoom: Z.city, paint: { "line-color": P.border, "line-width": 0.45 * PX_PER_MM } });
    }
    if (CITY_COLOUR_RELIEF && map.getSource("relief")) {   // City relief: the coloured one, a little see-through
      map.addLayer({ id: "relief-city", type: "raster", source: "relief", minzoom: Z.city, maxzoom: Z.street,
        paint: { "raster-opacity": 0.88, "raster-fade-duration": 0, "raster-resampling": "linear" } });
    } else relief(1);                                      // City relief (city view, washed light)
    // Served Area (from Barangay Monitoring): city view one soft tint; street view the barangays in 4 soft colours
    // with their borders, the served ones with an inner SCWD-blue line
    map.addSource("bgy", { type: "geojson", data: areas });
    const SERVED = ["!=", ["get", "status"], "not_served"] as maplibregl.FilterSpecification;
    map.addLayer({ id: "served-city", type: "fill", source: "bgy", minzoom: Z.city, maxzoom: Z.street, filter: SERVED,
      paint: { "fill-color": P.served, "fill-opacity": CITY_COLOUR_RELIEF ? 0.22 : 0.55 } });
    const PASTEL = ["match", ["coalesce", ["get", "pastel"], 0], 1, P.pastels["1"], 2, P.pastels["2"], 3, P.pastels["3"], 4, P.pastels["4"], LAND];
    map.addLayer({ id: "served", type: "fill", source: "bgy", minzoom: Z.street, paint: { "fill-color": PASTEL as never } });
    map.addLayer({ id: "bgy-line", type: "line", source: "bgy", minzoom: Z.street, paint: { "line-color": P.border, "line-width": 0.45 * PX_PER_MM } });
    map.addLayer({ id: "served-line", type: "line", source: "bgy", minzoom: Z.street, filter: SERVED,
      paint: { "line-color": P.servedLine, "line-width": 0.6 * PX_PER_MM, "line-offset": 0.45 * PX_PER_MM + 1 } });
    map.addLayer({ id: "bgy-state", type: "fill", source: "bgy", filter: ["all", ["has", "state"], ["!=", ["get", "state"], null]] as never, layout: { visibility: "none" },
      paint: { "fill-color": ["match", ["get", "state"], "ok", P.tints.ok, "attention", P.tints.attention, "down", P.tints.down, P.tints.nodata], "fill-opacity": 1, "fill-outline-color": "#ffffff" } });
    if (bg) {
      // Streets: white with a light edge; majors from the city view, mid from 1:60,000, minor from 1:30,000
      map.addSource("streets", { type: "geojson", data: bg.streets });
      // TRIAL: the other municipalities' roads, drawn as the city's (no file = the city's streets only)
      const roadSources = ["streets"];
      if (bg.provinceRoads) { map.addSource("provroads", { type: "geojson", data: bg.provinceRoads }); roadSources.unshift("provroads"); }
      const roads: [string, number, number][] = CITY_COLOUR_RELIEF
        ? [["minor", 0.5, Z.mid], ["mid", 0.9, Z.city + 0.3], ["major", 1.4, Z.city]]      // the road map shows sooner
        : [["minor", 0.5, Z.minor], ["mid", 0.9, Z.mid], ["major", 1.4, Z.city]];
      // over the coloured relief (city view) the roads get a darker outline; the street view keeps the light one
      const edge = CITY_COLOUR_RELIEF ? ["step", ["zoom"], CITY_ROAD_EDGE, Z.street, STREET_EDGE] : STREET_EDGE;
      const sfx = (src: string) => (src === "streets" ? "" : `-${src}`);           // the city's layers keep their ids
      for (const src of roadSources)
        for (const [cls, w, z] of roads)
          map.addLayer({ id: `street-edge-${cls}${sfx(src)}`, type: "line", source: src, minzoom: z, filter: ["==", ["get", "class"], cls],
            layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": edge as never, "line-width": (w + 0.4) * PX_PER_MM } });
      for (const src of roadSources)
        for (const [cls, w, z] of roads)
          map.addLayer({ id: `street-${cls}${sfx(src)}`, type: "line", source: src, minzoom: z, filter: ["==", ["get", "class"], cls],
            layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": STREET, "line-width": w * PX_PER_MM } });
      for (const src of roadSources)
        map.addLayer({ id: `street-name${sfx(src)}`, type: "symbol", source: src, minzoom: Z.streetNames,
          layout: { "symbol-placement": "line", "text-field": ["coalesce", ["get", "name"], ""], "text-font": ["Noto Sans Regular"], "text-size": 7 * PX_PER_PT },
          paint: { "text-color": "#8a94a6", ...halo, "text-halo-width": 1.4 } });
    }
    map.addSource("focusmask", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: "focus-veil", type: "fill", source: "focusmask", paint: { "fill-color": "#ffffff", "fill-opacity": 0.7 } });
    map.addLayer({ id: "focus-line", type: "line", source: "bgy", filter: ["==", ["get", "id"], "__none__"],
      paint: { "line-color": P.ink, "line-width": 1.2 * PX_PER_MM } });
    for (const lid of ["served", "served-city"])
      map.on("click", lid, (e) => { if (e.defaultPrevented) return; const id = e.features?.[0]?.properties.id; if (bgys().some((x) => x.id === id)) focusBarangay(id); });
    const tip = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: "tip", offset: 12 });
    for (const lid of ["served", "served-city"]) {
      map.on("mousemove", lid, (e) => {
        const b = bgys().find((x) => x.id === e.features?.[0]?.properties.id);
        if (!b) { tip.remove(); return; }
        map.getCanvas().style.cursor = "pointer";
        tip.setLngLat(e.lngLat).setHTML(`<b>${esc(b.name)}</b><br><span style="color:${mapCol(b.state)}">${esc(b.headline || LBL[b.state ?? ""] || "")}</span><br><span style="color:#64748b">Click to see it on its own</span>`).addTo(map);
      });
      map.on("mouseleave", lid, () => { tip.remove(); map.getCanvas().style.cursor = ""; });
    }
    map.addSource("pipes", { type: "geojson", data: pipes });
    const tiers: [string, maplibregl.FilterSpecification, number][] = [["trunk", ["in", ["get", "class"], ["literal", ["transmission", "dist_main"]]], 10],
      ["branch", ["==", ["get", "class"], "dist_secondary"], 13.5], ["service", ["==", ["get", "class"], "service"], 15.5]];
    for (const [n, f, z] of tiers) {
      map.addLayer({ id: `pc-${n}`, type: "line", source: "pipes", filter: f, minzoom: z, layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#ffffff", "line-width": ["+", WIDTH, 1.8] as never } });
      map.addLayer({ id: `p-${n}`, type: "line", source: "pipes", filter: f, minzoom: z, layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": n === "trunk" ? P.main : P.branch, "line-width": WIDTH as never, ...(n === "service" ? { "line-dasharray": [1, 1.5] } : {}) } });
      map.addLayer({ id: `pf-${n}`, type: "line", source: "pipes", filter: ["all", f, ["!=", ["get", "alarm"], null]] as never, minzoom: z,
        paint: { "line-color": COL.down, "line-width": ["+", WIDTH, 1] as never, "line-dasharray": [2, 1.5] } });
    }
    for (const id of ["p-trunk", "p-branch", "p-service", "pf-trunk", "pf-branch"])
      map.on("click", id, (e) => { const uid = e.features?.[0]?.properties.uid; const p = pipes.features.find((x) => x.properties.uid === uid); if (p && p.properties.alarm) openPipe(p.properties.uid); });
    map.on("click", "bgy-state", (e) => { const id = e.features?.[0]?.properties.id; if (view === MON.views[3] && bgys().some((x) => x.id === id)) focusBarangay(id); });

    // ---- labels, on top (as QGIS draws labels over every layer)
    if (bg) {
      // Sorsogon Barangays' names (the city's): small and light in the city view, larger and dark in the street view
      map.addSource("bgylabels", { type: "geojson", data: bg.barangayLabels });
      const city = ["==", ["get", "town"], "Sorsogon City"] as maplibregl.FilterSpecification;
      map.addLayer({ id: "bgy-name-city", type: "symbol", source: "bgylabels", minzoom: Z.bgyNames, maxzoom: Z.street, filter: city,
        layout: { "text-field": ["upcase", ["get", "name"]], "text-font": ["Noto Sans Regular"], "text-size": 7 * PX_PER_PT,
          "text-letter-spacing": 0.065, "text-max-width": 9, "text-padding": 3 },
        paint: { "text-color": "#7a8699", ...halo, "text-halo-width": 1.6 } });
      map.addLayer({ id: "bgy-name", type: "symbol", source: "bgylabels", minzoom: Z.street, filter: city,
        layout: { "text-field": ["upcase", ["get", "name"]], "text-font": ["Noto Sans Bold"], "text-size": 8.2 * PX_PER_PT,
          "text-letter-spacing": 0.06, "text-max-width": 9, "text-padding": 3 },
        paint: { "text-color": P.bgyName, ...halo, "text-halo-width": 1.8 } });
      // Sorsogon Municipalities' names in the province view, Sorsogon City with its water network's summary under it
      map.addSource("munilabels", { type: "geojson", data: bg.municipalityLabels });
      map.addLayer({ id: "muni-name", type: "symbol", source: "munilabels", maxzoom: Z.city,
        layout: { "text-field": ["upcase", ["get", "name"]], "text-font": ["Noto Sans Bold"], "text-size": 9 * PX_PER_PT,
          "text-letter-spacing": 0.05, "text-max-width": 12, "text-offset": [0, -0.65], "text-allow-overlap": true },
        paint: { "text-color": P.ink, ...halo, "text-halo-width": 2 } });
      map.addLayer({ id: "muni-summary", type: "symbol", source: "munilabels", maxzoom: Z.city, filter: ["==", ["get", "name"], "Sorsogon City"],
        layout: { "text-field": "", "text-font": ["Noto Sans Regular"], "text-size": 8.2 * PX_PER_PT, "text-offset": [0, 0.75],
          "text-allow-overlap": true, "text-max-width": 40 },
        paint: { "text-color": COL.ok!, ...halo, "text-halo-width": 2 } });
    }
    map.addLayer({ id: "bgy-label", type: "symbol", source: "bgy", filter: ["all", ["has", "state"], ["!=", ["get", "state"], null]] as never, minzoom: 11.5, layout: { visibility: "none",
      "text-field": ["format", ["upcase", ["get", "name"]], { "font-scale": 0.95 }, "\n", {},
        ["match", ["get", "state"], "ok", "Working", "attention", "Needs attention", "down", "Not working", "No current data"], { "text-color": ["match", ["get", "state"], "ok", COL.ok, "attention", "#b45309", "down", COL.down, "#64748b"] }] as never,
      "text-font": ["Noto Sans Bold"], "text-size": 7.6 * PX_PER_PT, "text-max-width": 10 },
      paint: { "text-color": P.ink, ...halo, "text-halo-width": 1.6 } });
    addMarkers();
    setView(MON.views[0]!);
    renderCitySummary();
    map.once("idle", () => onReady?.());
  });
  function zoomClasses() {
    const z = map.getZoom();
    mapEl.classList.toggle("z-province", z < 11);
    mapEl.classList.toggle("z-city", z >= 11 && z < 13);
    mapEl.classList.toggle("z-label", z >= 13.3);
    mapEl.classList.toggle("z-close", z >= 15.2);
    for (const m of gaugeMarkers) m.el.classList.toggle("hide", z < 11 || !(m.problem || z >= 13.2 || view === MON.views[1]));
  }
  map.on("zoom", zoomClasses);

  type GaugeMarker = { el: HTMLElement; wrap: HTMLElement; problem: boolean; g: Gauge; marker: Marker };
  const gaugeMarkers: GaugeMarker[] = [], stationMarkers: { el: HTMLElement; f: Facility; marker: Marker }[] = [];
  function addMarkers() {
    for (const m of [...gaugeMarkers, ...stationMarkers]) m.marker.remove();
    gaugeMarkers.length = 0;
    stationMarkers.length = 0;
    for (const f of stations) {
      const el = document.createElement("div");
      const twin = !!f.state && f.state !== "notwin";
      el.className = `st ${f.state || "nodata"} ${f.kind || "station"}`;
      const hl = twin ? (f.headline || "") : `${MON.siteLabels[f.kind] || "Site"} · not in the twin yet`;
      const parts = twin ? (f.groups || []).map((g) => `<span title="${esc(g.title)}: ${esc(LBL[g.state] || "")}">${MON.groupIcons[g.group]}<i style="background:${COL[g.state] || COL.nodata}"></i></span>`)
        : (f.roles || []).filter((r) => (MON.groupIcons as Record<string, string>)[r]).map((r) => `<span>${(MON.groupIcons as Record<string, string>)[r]}</span>`);
      el.innerHTML = `<span class="dot ${f.state === "down" || f.state === "attention" ? "bad" : ""}" style="background:${COL[f.state ?? ""] || COL.nodata}"></span>` +
        `<div class="lab"><div class="nm">${esc(f.name)}</div><div class="hl" style="color:${mapCol(f.state)}">${esc(hl)}</div></div>` +
        `<span class="site">${MON.sites[twin || f.kind !== "station" ? f.kind || "station" : "station-muted"] ?? ""}</span>` +
        (twin && !(f.problems || []).length ? `<span class="mini">${MON.badges[f.state!] || MON.badges.nodata}</span>` : "") +
        (twin && (f.problems || []).length ? `<div class="bubble ${f.problems[0]!.state === "down" ? "down" : ""}" title="${esc(f.headline || "")}">` +
          f.problems.map((p) => `<span>${MON.groupIcons[p.group]}<b>${MON.badges[p.state] || MON.badges.attention}</b></span>`).join("") + `</div>` : "") +
        `<div class="eq">${parts.join("")}</div>`;
      el.onclick = (ev) => { ev.stopPropagation(); openStation(f.uid, false); };
      el.title = [f.name, hl, f.affects ? `Affects ${affectsText(f.affects)}` : "", f.action ? `→ ${f.action}` : ""].filter(Boolean).join("\n");
      stationMarkers.push({ el, f, marker: new maplibregl.Marker({ element: el }).setLngLat([f.lon, f.lat]).addTo(map) });
    }
    for (const g of gauges) {
      const el = document.createElement("div");      // positioned by MapLibre (absolute); its label sits against it
      const box = document.createElement("div");
      const st = g.state || "nodata";
      if (g.type === "pressure_logger") {                // a DPP: its gauge dial
        box.className = "ga gauge";
        box.innerHTML = gaugeSvg(g.psi, st === "notwin" ? "nodata" : st, COL);
      } else {
        box.className = `ga ${g.type === "chlorine_point" ? "dia" : "sq"} ${st === "nodata" ? "nodata" : ""}`;
        box.style.background = st === "nodata" ? "#fff" : (COL[st] || COL.nodata!);
      }
      el.appendChild(box);
      const lab = document.createElement("div");
      lab.className = "glab";
      lab.textContent = g.type === "pressure_logger" ? (g.psi != null && st !== "nodata" ? `${g.psi} psi` : "no reading") : (g.chlorine != null ? `${g.chlorine} ppm` : "");
      lab.dataset.focus = `${g.name} · ` + (g.type === "pressure_logger" ? (g.psi != null && st !== "nodata" ? `${g.psi} psi` : "not reporting") : (g.chlorine != null ? `${g.chlorine} ppm chlorine` : "not reporting"));
      lab.dataset.plain = lab.textContent;
      el.appendChild(lab);
      el.onclick = (ev) => { ev.stopPropagation(); openGauge(g.uid, false); };
      el.title = [g.name, g.headline || LBL[st] || "", g.action ? `→ ${g.action}` : ""].filter(Boolean).join("\n");
      el.classList.add("gw");
      el.dataset.ll = `${g.lon},${g.lat}`;
      gaugeMarkers.push({ el: box, wrap: el, problem: ["down", "attention", "nodata"].includes(st), g,
        marker: new maplibregl.Marker({ element: el }).setLngLat([g.lon, g.lat]).addTo(map) });
    }
    applyFocusClasses();
    select(selUid);
  }

  // ---------------------------------------------------------------- views
  const VIEW_KEYS = ["overview", "pressure", "equipment", "barangays", "health"];
  function setView(name: string) {
    view = name;
    const k = VIEW_KEYS[MON.views.indexOf(name)]!;
    for (const key of VIEW_KEYS) mapEl.classList.toggle(`v-${key}`, key === k);
    const vis = (id: string, on: boolean) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    vis("bgy-state", k === "barangays"); vis("bgy-label", k === "barangays"); vis("served", k !== "barangays");
    vis("served-line", k !== "barangays"); vis("served-city", k !== "barangays");
    vis("bgy-name", k !== "barangays"); vis("bgy-name-city", k !== "barangays");
    for (const n of ["trunk", "branch", "service"])
      if (map.getLayer(`p-${n}`)) map.setPaintProperty(`p-${n}`, "line-color", k === "pressure" ? BAND : (k === "barangays" || k === "health") ? "#c3ccd8" : (n === "trunk" ? P.main : P.branch));
    for (const m of gaugeMarkers) {
      if (m.g.type === "pressure_logger") {
        const health = ({ live: "ok", late: "attention" } as Record<string, MonState>)[m.g.data ?? ""] ?? "nodata";
        m.el.innerHTML = k === "health" ? gaugeSvg(health !== "nodata" ? m.g.psi : null, health, COL) : gaugeSvg(m.g.psi, m.g.state && m.g.state !== "notwin" ? m.g.state : "nodata", COL);
        continue;
      }
      const st = k === "health" ? (({ live: "ok", late: "attention", offline: "nodata" } as Record<string, string>)[m.g.data ?? ""] || "nodata") : (m.g.state || "nodata");
      m.el.style.background = st === "nodata" ? "#fff" : COL[st]!;
      m.el.classList.toggle("nodata", st === "nodata");
    }
    for (const { el, f } of stationMarkers) {
      if (!f.state || f.state === "notwin") continue;
      const st = k === "health" ? (({ live: "ok", late: "attention", offline: "down" } as Record<string, string>)[f.data ?? ""] || "nodata") : f.state;
      let mini = el.querySelector<HTMLElement>(".mini");
      if (!mini && k === "health") { mini = document.createElement("span"); mini.className = "mini"; el.appendChild(mini); }
      if (mini) mini.innerHTML = (MON.badges as Record<string, string>)[st] || MON.badges.nodata;
    }
    const SHORT = ["Overview", "Pressure", "Equipment", "Barangays", "Data"];
    $("#views").innerHTML = MON.views.map((v, i) => `<button class="${v === view ? "on" : ""}" title="${esc(v.split(" ").slice(1).join(" "))}">${SHORT[i] || esc(v)}</button>`).join("");
    root.querySelectorAll<HTMLElement>("#views button").forEach((b, i) => b.onclick = () => setView(MON.views[i]!));
    legend(k);
    zoomClasses();
  }
  let legendClosed = false;
  $("#legend").addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest("[data-lg]")) return;
    legendClosed = !legendClosed;
    legend(VIEW_KEYS[MON.views.indexOf(view)]!);
  });
  function legend(k: string) {
    const rows = k === "health"
      ? [["ok", "All sensors reporting"], ["down", "A sensor is offline"], ["notwin", "Not in the twin yet"]]
      : [["ok", "Working"], ["attention", "Needs attention"], ["down", "Not working"], ["nodata", "No current data"], ["notwin", "Not in the twin yet"]];
    let html = `<div class="t">${k === "pressure" ? "WATER PRESSURE" : k === "barangays" ? "BARANGAYS" : k === "health" ? "DATA HEALTH" : "STATE"}</div>`;
    if (k === "pressure") html += [[COL.ok, "OK (7 psi or more)"], [COL.attention, "Low (3–7 psi)"], [COL.down, "Very low (under 3 psi)"], ["#b8c2cf", "No pressure point nearby"]].map(([c, t]) => `<div><span class="ln" style="background:${c}"></span>${t}</div>`).join("");
    else if (k === "barangays") html += ([["ok", "Working"], ["attention", "Needs attention"], ["down", "Not working"], ["nodata", "No current data"]] as const).map(([s, t]) => `<div><span class="ln" style="background:${P.tints[s]};height:12px;width:16px;border:1px solid #cbd5e1"></span>${t}</div>`).join("");
    else {
      html += rows.filter(([s]) => s !== "notwin").map(([s, t]) => `<div>${badge(s)}${t}</div>`).join("");
      html += `<div class="t" style="margin-top:6px">SITES</div>` + [["station", "Pumping station (live)"], ["station-muted", "Station not in the twin yet"], ["reservoir", "Reservoir"], ["spring", "Spring source"], ["intake", "Intake / treatment"], ["proposed", "Proposed site"]]
        .map(([s, t]) => `<div><span class="badge b">${MON.sites[s!] ?? ""}</span>${t}</div>`).join("");
    }
    if (k !== "health") html += `<div><span class="badge b">${MON.badges.down}</span>Speech bubble: the part with a problem</div>`;
    html += `<div><span class="ln" style="background:repeating-linear-gradient(90deg,${COL.down} 0 6px,transparent 6px 10px)"></span>Reported pipe problem</div>`;
    $("#legend").innerHTML = `<button class="lg-toggle" data-lg>${legendClosed ? "Show" : "Hide"}</button>` + (legendClosed ? `<div class="t">LEGEND</div>` : "") + `<div class="lg-body">${html}</div>`;
    $("#legend").classList.toggle("closed", legendClosed);
  }

  // ---------------------------------------------------------------- live status from the digital twin
  let lastLive: LiveResponse | null = null;
  function newestReading(): string | null {
    let newest: string | null = null;
    for (const f of stations) for (const g of f.groups || []) for (const s of g.all) if (s.time && (!newest || s.time > newest)) newest = s.time;
    for (const g of gauges) if (g.twin_id && g.time && (!newest || g.time > newest)) newest = g.time;
    return newest;
  }
  let lastChecked: string | null = null;
  function setBadge(checked: string | null) {
    if (!lastLive) return;
    const checkedAt = (lastChecked = checked ?? lastChecked);
    const src = lastLive.source === "adt" ? "Live from Azure Digital Twins" : `Digital twin file (${lastLive.label})`;
    const newest = newestReading();
    badgeText = [src, checkedAt ? `checked ${new Date(checkedAt).toLocaleTimeString()}` : "",
      newest ? `latest reading ${age(newest)}` : "no readings yet", lastLive.shifted ? "reading times moved to now (demo)" : ""].filter(Boolean).join(" · ");
    renderHeader();
  }
  // ---- toasts: a station or gauge that just got a problem (or got well again), as the twin reports it
  const toastTimers: ReturnType<typeof setTimeout>[] = [];
  function toast(st: MonState, kind: string, name: string, text: string | null, open: () => void) {
    const box = $("#toasts");
    const el = document.createElement("div");
    el.className = `toast ${st}`;
    el.innerHTML = `${badge(st)}<div><div class="k">${esc(kind)}</div><div class="n">${esc(name)}</div><div class="h">${esc(text || "")}</div></div>`;
    el.onclick = () => { open(); el.remove(); };
    box.prepend(el);
    while (box.children.length > 4) box.lastElementChild!.remove();
    toastTimers.push(setTimeout(() => { el.classList.add("out"); toastTimers.push(setTimeout(() => el.remove(), 350)); }, 9000));
  }
  const worse = (a: string | null | undefined, b: string | null | undefined) => (RANK[a ?? ""] ?? 9) < (RANK[b ?? ""] ?? 9);
  function announce(prevSt: Map<string, string | null>, prevGa: Map<string, string | null>) {
    for (const f of stations) {
      if (!f.twin_id || !prevSt.has(f.uid)) continue;
      const was = prevSt.get(f.uid);
      if ((f.state === "down" || f.state === "attention") && worse(f.state, was)) toast(f.state, "New problem · station", f.name, f.headline, () => openStation(f.uid, true));
      else if (f.state === "ok" && (was === "down" || was === "attention")) toast("ok", "Back to normal · station", f.name, f.headline, () => openStation(f.uid, true));
    }
    for (const g of gauges) {
      if (!g.twin_id || !prevGa.has(g.uid)) continue;
      const was = prevGa.get(g.uid);
      if ((g.state === "down" || g.state === "attention" || g.state === "nodata") && worse(g.state, was))
        toast(g.state, `${g.state === "nodata" ? "Not reporting" : "New problem"} · ${g.type === "pressure_logger" ? "pressure point" : "chlorine"}`, g.name, g.headline, () => openGauge(g.uid, true));
      else if (g.state === "ok" && (was === "down" || was === "attention" || was === "nodata"))
        toast("ok", "Back to normal · gauge", g.name, g.headline, () => openGauge(g.uid, true));
    }
  }

  function applyLive(s: LiveResponse) {
    // what each station and gauge was before this update (none before the first: that is no news)
    const prevSt = new Map(lastLive ? stations.map((f) => [f.uid, f.state] as const) : []);
    const prevGa = new Map(lastLive ? gauges.map((g) => [g.uid, g.state] as const) : []);
    lastLive = s;
    live = "live";
    const M = s.monitor;
    for (const f of stations) {
      if (!f.twin_id) continue;
      const m = M.stations[f.twin_id];
      if (m) Object.assign(f, m);
      else Object.assign(f, { state: "nodata", headline: "Not found in the digital twin", issues: [], groups: [], problems: [], action: null, affects: null, data: "none" });
    }
    for (const g of gauges) {
      if (!g.twin_id) continue;
      const v = s.gauges[g.twin_id], m = M.gauges[g.twin_id];
      if (v && m) Object.assign(g, {
        psi: v.kind === "pressure" ? v.value : null, chlorine: v.kind === "chlorine" ? v.value : null, time: v.time,
        status: v.status, alarm: v.alarm, band: v.band, ...m,
      });
      else Object.assign(g, { state: "nodata", headline: "Not found in the digital twin", psi: null, chlorine: null, time: null, data: "none", action: null, affects: null });
    }
    for (const f of pipes.features as PipeFeature[]) {
      const p = f.properties;
      if (p.twin_id) Object.assign(p, M.pipes[p.twin_id] ?? { alarm: null, action: null });
      const band = p.dpp_twin_id ? s.gauges[p.dpp_twin_id]?.band : undefined;
      if (band) p.band = band;
    }
    for (const f of areas.features) {
      const b = f.properties;
      if (!b.state) continue;
      const m = M.barangays[b.id], v = s.barangays[b.id];
      if (m) Object.assign(b, { state: m.state ?? "nodata", headline: m.headline });
      if (v) Object.assign(b, { psi: v.psi, time: v.time });
    }
    city = M.city;
    renderAll();
    announce(prevSt, prevGa);
  }
  function renderAll() {
    renderHeader();
    renderCards();
    renderAttention();
    renderCitySummary();
    renderPlaces();
    if (loaded) {
      (map.getSource("pipes") as GeoJSONSource | undefined)?.setData(pipes);
      (map.getSource("bgy") as GeoJSONSource | undefined)?.setData(areas);
      addMarkers();
      setView(view);
    }
    rerenderDetail();
    scada.update();
  }
  map.on("load", () => { if (lastLive) renderAll(); });

  // ---------------------------------------------------------------- SCADA: alarm console, status grid, faceplates
  const scada = startScada({
    root, stations: () => stations, gauges: () => gauges, labels: LBL,
    openStation: (uid) => openStation(uid, true), openGauge: (uid) => openGauge(uid, true),
    openPipeOf: (id) => { const p = pipes.features.find((x) => x.properties.twin_id === id); if (p) openPipe(p.properties.uid); },
    onLayout: () => map.resize(),
  });
  // the stage changes size with the alarm console: the map follows
  const ro = new ResizeObserver(() => map.resize());
  ro.observe(mapEl);

  const es = new EventSource("/api/status/stream");
  es.addEventListener("alarms", (e) => {
    const { alarms } = JSON.parse((e as MessageEvent<string>).data) as { alarms: Alarm[] };
    scada.setAlarms(alarms);
  });
  es.addEventListener("status", (e) => {
    const { status } = JSON.parse((e as MessageEvent<string>).data) as { status: LiveResponse };
    applyLive(status);
    setBadge(status.fetchedAt);
  });
  es.addEventListener("checked", (e) => {
    const { fetchedAt } = JSON.parse((e as MessageEvent<string>).data) as { fetchedAt: string };
    if (live !== "live" && lastLive) { live = "live"; renderAttention(); }
    setBadge(fetchedAt);
  });
  es.addEventListener("twin-error", () => {
    live = "error";
    badgeText = lastLive ? "Twin unreachable · showing the last status" : "Twin unreachable · check ADT_URL and the Azure sign-in";
    renderHeader();
    renderAttention();
  });
  // ages ("5 min ago") move on without a new status
  const tick = setInterval(() => { if (lastLive) { setBadge(null); renderAttention(); } }, 60_000);

  renderAll();
  return () => {
    es.close();
    clearInterval(tick);
    scada.stop();
    ro.disconnect();
    detail.removeEventListener("click", onDetailClick);
    detail.removeEventListener("toggle", onToggle, true);
    for (const t of toastTimers) clearTimeout(t);
    document.removeEventListener("keydown", onKey);
    map.remove();
  };
}

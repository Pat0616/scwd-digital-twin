// The Sorsogon Water Monitor page: a port of the QGIS plugin's monitor_template.html (same look, wording, zoom
// tiers, views, barangay focus and search). The static GIS comes from /gis/*.json (npm run import-gis); the live
// status comes from the server's Server-Sent Events stream (/api/status/stream) and is merged in place by twin id.

import maplibregl from "maplibre-gl";
import type { GeoJSONSource, Map as MlMap, Marker } from "maplibre-gl";
import type {
  BgyAreaProps, Facility, GisData, MeterProps, MonState, PipeFeature,
} from "@/lib/gis/types";
import type { LiveResponse } from "@/lib/status/types";
import { gaugeSvg } from "./gauge";

type Gauge = MeterProps & { lon: number; lat: number };
type Bgy = BgyAreaProps;
type Row = { st: MonState; kind: string; name: string; text: string | null; affects?: string | null; action?: string | null; when: string; open: () => void };
type Current =
  | { kind: "station"; uid: string; all: boolean }
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
/** Sorsogon's outline (public/gis/province.json, from data/sorsogon_admin.gpkg's "province" layer). */
export type ProvinceData = GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon>;
const PROVINCE_PAD = 0.02;  // degrees (about 2 km) the map may show past the province's edge

function bboxOfAll(fc: ProvinceData): Extent {
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

/** A box around the province with every part of it (its islands too) cut out as a hole. */
function outsideMask(fc: ProvinceData): GeoJSON.Feature<GeoJSON.Polygon> {
  const [[x0, y0], [x1, y1]] = bboxOfAll(fc), m = 5;
  const outer: GeoJSON.Position[] = [[x0 - m, y0 - m], [x1 + m, y0 - m], [x1 + m, y1 + m], [x0 - m, y1 + m], [x0 - m, y0 - m]];
  const parts = fc.features.flatMap((f) => (f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates));
  const clockwise = (r: GeoJSON.Position[]) => r.reduce((a, p, i) => { const q = r[(i + 1) % r.length]!; return a + (q[0]! - p[0]!) * (q[1]! + p[1]!); }, 0) > 0;
  const holes = parts.map((poly) => poly[0]!).map((r) => (clockwise(r) ? r : [...r].reverse()));
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [outer, ...holes] } };
}

export function startMonitor(root: HTMLElement, gis: GisData, province: ProvinceData | null): () => void {
  const $ = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const MON = gis.meta.monitor, COL = MON.colours as Record<string, string>, LBL = MON.labels as Record<string, string>;
  const RANK: Record<string, number> = Object.fromEntries(MON.rank.map((s, i) => [s, i]));
  const P = MON.palette;
  const badge = (st: string | null | undefined, cls = "b") => `<span class="badge ${cls}">${(MON.badges as Record<string, string>)[st ?? ""] || MON.badges.nodata}</span>`;
  const textCol = (st: string | null | undefined) => st === "attention" ? "var(--attention-text)" : (COL[st ?? ""] || "var(--text)");
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
    $("#attTitle").textContent = `NEEDS ATTENTION (${rows.length})`;
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
    $("#citySummary").innerHTML = `Sorsogon City water · <span style="color:var(--ok)">${c.ok || 0} working</span>` +
      (c.down ? ` · <span style="color:var(--down)">${c.down} not working</span>` : "") +
      (c.attention ? ` · <span style="color:var(--attention-text)">${c.attention} need attention</span>` : "");
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
  function closeDetail() { side.classList.remove("showing"); current = null; }
  function head(title: string, st: string | null | undefined, hl: string | null | undefined, where?: string) {
    return `<div class="head">${badge(st)}<div><h2>${esc(title)}</h2><div class="hl" style="color:${textCol(st)}">${esc(hl || LBL[st ?? ""] || "")}</div>${where ? `<div class="where">${esc(where)}</div>` : ""}</div></div>`;
  }
  function tiles(list: Facility["groups"][number]["all"]) {
    return `<div class="tiles">` + list.map((s) => {
      const lim = [s.min != null ? `min ${s.min}` : "", s.max != null ? `max ${s.max}` : ""].filter(Boolean).join(" · ");
      return `<div class="tile ${s.alarm || s.offline ? "alarm" : ""}"><div class="tn" title="${esc(s.name)}">${esc(s.name)}</div><div class="tv">${esc(s.value)}</div>` +
        (s.pct != null ? `<div class="bar"><i style="width:${Math.max(0, Math.min(100, s.pct))}%"></i></div>` : "") +
        `<div class="tm">${esc([lim, s.offline ? "sensor offline" : age(s.time)].filter(Boolean).join(" · "))}</div></div>`;
    }).join("") + `</div>`;
  }
  function fieldTable(rows: Facility["fieldReadings"] | undefined) {
    if (!rows || !rows.length) return "";
    return `<div class="note"><b>Field readings</b><table class="fr">` + rows.map((r) => `<tr><td>${esc(r.measure)}</td><td><b>${esc(r.value ?? "—")} ${esc(r.unit || "")}</b></td><td style="color:var(--faint)">${esc(age(r.time))} · ${esc(r.by || "")}</td></tr>`).join("") + `</table></div>`;
  }
  function openStation(uid: string, fly: boolean, all = false) {
    const f = stations.find((s) => s.uid === uid);
    if (!f) return;
    current = { kind: "station", uid, all };
    if (fly) map.flyTo({ center: [f.lon, f.lat], zoom: 16 });
    if (f.state === "notwin" || !f.twin_id) {
      showDetail(head(f.name, "notwin", "Not in the digital twin yet", f.barangay ? `${f.barangay}, Sorsogon City` : "") +
        `<div class="note">This station is on the SCWD official map but not in the digital twin yet, so there are no live readings. Add it to Azure Digital Twins to monitor it here.</div>`);
      return;
    }
    let html = head(f.name, f.state, (f.headline || "").split(" (+")[0], f.barangay ? `${f.barangay}, Sorsogon City` : "") + todo(f);
    if ((f.issues || []).length > 1) html += `<div class="issues"><b>Needs attention</b>${f.issues.map((i) => "• " + esc(i)).join("<br>")}</div>`;
    for (const g of f.groups) {
      const word = ({ ok: "Working", attention: "Check", down: "Not working", nodata: "No data" } as Record<string, string>)[g.state] || "";
      html += `<div class="group ${g.state}"><div class="gh"><span class="badge ic">${MON.groupIcons[g.group]}</span><span class="gt">${esc(g.title)}</span><span class="pill ${g.state}">${word}</span></div>` +
        (g.issues.length ? `<div class="gi">${g.issues.map(esc).join("; ")}</div>` : "") + tiles(all ? g.all : g.key) + `</div>`;
    }
    const total = f.groups.reduce((n, g) => n + g.all.length, 0);
    if (f.groups.length) html += `<div class="more"><a data-act="${all ? "summary" : "all"}" data-uid="${esc(f.uid)}">${all ? "Show the summary" : `Show all ${total} live readings`}</a></div>`;
    html += fieldTable(f.fieldReadings) + `<div class="twin">Twin id: ${esc(f.twin_id || "—")}</div>`;
    showDetail(html);
  }
  function openGauge(uid: string, fly: boolean) {
    const g = gauges.find((x) => x.uid === uid);
    if (!g) return;
    current = { kind: "gauge", uid };
    if (fly) map.flyTo({ center: [g.lon, g.lat], zoom: 16 });
    const what = g.type === "pressure_logger" ? "Designated Pressure Point (DPP)" : "Far-point chlorine check";
    const range = g.type === "pressure_logger" ? "Safe range: at least <b>7 psi</b> (SCWD minimum). Below 3 psi means little or no water at the tap."
      : "Safe range: <b>0.3 – 1.5 ppm</b> free chlorine at the end of the line.";
    const value = g.type === "pressure_logger" ? (g.psi != null ? `${g.psi} psi` : "—") : (g.chlorine != null ? `${g.chlorine} ppm` : "—");
    showDetail(head(g.name, g.state || "nodata", g.headline, what) + todo(g) +
      `<div class="note">${range}<br>Reading: <b>${esc(value)}</b> · ${esc(age(g.time) || "no reading")}${g.status === "offline" ? " · sensor offline" : ""}</div>` +
      fieldTable(g.fieldReadings) + `<div class="twin">Twin id: ${esc(g.twin_id || "—")}</div>`);
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
      const parts = (s.problems || []).length ? `<div class="parts">` + s.problems.map((q) => `<span>${MON.groupIcons[q.group]}<b>${MON.badges[q.state] || MON.badges.attention}</b></span>`).join("") + `</div>` : "";
      return row(`s:${s.uid}`, pic, s.name, twin ? s.headline : "Not in the digital twin yet", s.state || "nodata", parts, "site");
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
    if (c.kind === "station") openStation(c.uid, false, c.all);
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
    else if (act === "all" || act === "summary") openStation(t.dataset.uid!, false, act === "all");
  };
  detail.addEventListener("click", onDetailClick);
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") clearFocus(); };
  document.addEventListener("keydown", onKey);

  // ---------------------------------------------------------------- map
  // held to Sorsogon (as scwd-frontend): it opens on the city, and can neither pan nor zoom out past the province
  const extent: Extent = province ? bboxOfAll(province) : [[gis.meta.bounds[0], gis.meta.bounds[1]], [gis.meta.bounds[2], gis.meta.bounds[3]]];
  const map: MlMap = new maplibregl.Map({ container: mapEl, style: "https://tiles.openfreemap.org/styles/positron",
    bounds: CITY_BOUNDS, maxBounds: lockedBounds(extent, mapEl), renderWorldCopies: false, attributionControl: { compact: true } });
  map.on("resize", () => map.setMaxBounds(lockedBounds(extent, mapEl)));
  // development only: lets a test browser check the map (marker positions, bounds)
  if (process.env.NODE_ENV !== "production") (window as unknown as { __monitorMap?: MlMap }).__monitorMap = map;
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");
  let view = MON.views[0]!;
  const WIDTH = ["match", ["get", "class"], "transmission", 3.2, "dist_main", 2.8, "dist_secondary", 1.4, "service", 1, 1.2];
  const BAND = ["match", ["get", "band"], "very_low", COL.down, "low", COL.attention, "ok", COL.ok, "high", "#7c3aed", "#b8c2cf"];
  let loaded = false;
  map.on("load", () => {
    loaded = true;
    const firstSymbol = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
    map.addSource("bgy", { type: "geojson", data: areas });
    // province view: the atlas relief; city view: the same relief washed light (zoom 11-13)
    for (const r of MON.relief || []) {
      map.addSource(r.id, { type: "image", url: `/gis/${r.url}`, coordinates: r.corners as [[number, number], [number, number], [number, number], [number, number]] });
      map.addLayer({ id: r.id, type: "raster", source: r.id, ...(r.minzoom != null ? { minzoom: r.minzoom } : {}), ...(r.maxzoom != null ? { maxzoom: r.maxzoom } : {}),
        paint: { "raster-opacity": 1, "raster-fade-duration": 0 } }, firstSymbol);
    }
    // outside the province: solid sea over the basemap, the relief and the neighbours' names, so Sorsogon stands
    // alone (as QGIS's Outside Mask), with its border. Added on top of the basemap; the layers below are inserted
    // under its labels, inside the province.
    if (province) {
      map.addSource("outside", { type: "geojson", data: outsideMask(province) });
      map.addLayer({ id: "outside-mask", type: "fill", source: "outside", paint: { "fill-color": P.sea, "fill-opacity": 1, "fill-antialias": false } });
      map.addSource("province", { type: "geojson", data: province });
      map.addLayer({ id: "province-line", type: "line", source: "province", layout: { "line-join": "round" },
        paint: { "line-color": P.ink, "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1, 13, 2], "line-opacity": 0.45 } });
    }
    const SERVED = ["!=", ["get", "status"], "not_served"] as maplibregl.FilterSpecification;
    map.addLayer({ id: "served-city", type: "fill", source: "bgy", minzoom: 11, maxzoom: 13, filter: SERVED,
      paint: { "fill-color": P.served, "fill-opacity": 0.55 } }, firstSymbol);
    const PASTEL = ["match", ["coalesce", ["get", "pastel"], 0], 1, P.pastels["1"], 2, P.pastels["2"], 3, P.pastels["3"], 4, P.pastels["4"], P.land];
    map.addLayer({ id: "served", type: "fill", source: "bgy", minzoom: 13,
      paint: { "fill-color": PASTEL as never, "fill-opacity": 0.9 } }, firstSymbol);
    map.addLayer({ id: "served-line", type: "line", source: "bgy", minzoom: 13, filter: SERVED,
      paint: { "line-color": P.servedLine, "line-width": 2, "line-offset": 1.6, "line-opacity": 0.85 } }, firstSymbol);
    map.addLayer({ id: "bgy-state", type: "fill", source: "bgy", filter: ["all", ["has", "state"], ["!=", ["get", "state"], null]] as never, layout: { visibility: "none" },
      paint: { "fill-color": ["match", ["get", "state"], "ok", P.tints.ok, "attention", P.tints.attention, "down", P.tints.down, P.tints.nodata], "fill-opacity": 0.85 } }, firstSymbol);
    map.addLayer({ id: "bgy-line", type: "line", source: "bgy", minzoom: 13, paint: { "line-color": P.border, "line-width": 1.4 } }, firstSymbol);
    map.addLayer({ id: "bgy-name-city", type: "symbol", source: "bgy", minzoom: 11.6, maxzoom: 13,
      filter: ["==", ["get", "town"], "Sorsogon City"],
      layout: { "text-field": ["upcase", ["get", "name"]], "text-font": ["Noto Sans Regular"], "text-size": 9.5,
        "text-letter-spacing": 0.05, "text-max-width": 8, "text-padding": 6 },
      paint: { "text-color": "#7a8699", "text-halo-color": "#ffffff", "text-halo-width": 1.2 } });
    map.addLayer({ id: "bgy-name", type: "symbol", source: "bgy", minzoom: 13,
      filter: ["==", ["get", "town"], "Sorsogon City"],
      layout: { "text-field": ["upcase", ["get", "name"]], "text-font": ["Noto Sans Bold"], "text-size": 11,
        "text-letter-spacing": 0.05, "text-max-width": 8, "text-padding": 4 },
      paint: { "text-color": P.bgyName, "text-halo-color": "#ffffff", "text-halo-width": 1.6 } });
    map.addSource("focusmask", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: "focus-veil", type: "fill", source: "focusmask", paint: { "fill-color": "#ffffff", "fill-opacity": 0.7 } });
    map.addLayer({ id: "focus-line", type: "line", source: "bgy", filter: ["==", ["get", "id"], "__none__"],
      paint: { "line-color": P.ink, "line-width": 3 } });
    for (const lid of ["served", "served-city"])
      map.on("click", lid, (e) => { if (e.defaultPrevented) return; const id = e.features?.[0]?.properties.id; if (bgys().some((x) => x.id === id)) focusBarangay(id); });
    const tip = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: "tip", offset: 12 });
    for (const lid of ["served", "served-city"]) {
      map.on("mousemove", lid, (e) => {
        const b = bgys().find((x) => x.id === e.features?.[0]?.properties.id);
        if (!b) { tip.remove(); return; }
        map.getCanvas().style.cursor = "pointer";
        tip.setLngLat(e.lngLat).setHTML(`<b>${esc(b.name)}</b><br><span style="color:${textCol(b.state)}">${esc(b.headline || LBL[b.state ?? ""] || "")}</span><br><span style="color:var(--faint)">Click to see it on its own</span>`).addTo(map);
      });
      map.on("mouseleave", lid, () => { tip.remove(); map.getCanvas().style.cursor = ""; });
    }
    map.addLayer({ id: "bgy-label", type: "symbol", source: "bgy", filter: ["all", ["has", "state"], ["!=", ["get", "state"], null]] as never, minzoom: 11.5, layout: { visibility: "none",
      "text-field": ["format", ["upcase", ["get", "name"]], { "font-scale": 0.95 }, "\n", {},
        ["match", ["get", "state"], "ok", "Working", "attention", "Needs attention", "down", "Not working", "No current data"], { "text-color": ["match", ["get", "state"], "ok", COL.ok, "attention", "#b45309", "down", COL.down, "#64748b"] }] as never,
      "text-font": ["Noto Sans Bold"], "text-size": 11.5, "text-max-width": 10 },
      paint: { "text-color": P.ink, "text-halo-color": "#fff", "text-halo-width": 1.6 } });
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
    addMarkers();
    setView(MON.views[0]!);
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
        `<div class="lab"><div class="nm">${esc(f.name)}</div><div class="hl" style="color:${textCol(f.state)}">${esc(hl)}</div></div>` +
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
  function legend(k: string) {
    const rows = k === "health"
      ? [["ok", "All sensors reporting"], ["attention", "Some readings late"], ["down", "A sensor is offline"], ["notwin", "Not in the twin yet"]]
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
    $("#legend").innerHTML = html;
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
  function applyLive(s: LiveResponse) {
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
  }
  map.on("load", () => { if (lastLive) renderAll(); });

  const es = new EventSource("/api/status/stream");
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
    detail.removeEventListener("click", onDetailClick);
    document.removeEventListener("keydown", onKey);
    map.remove();
  };
}

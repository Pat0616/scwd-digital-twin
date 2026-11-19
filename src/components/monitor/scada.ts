// The SCADA screens of the monitor, in the ISA-101 high-performance style: greys for everything normal, colour only
// for what is abnormal (always with a priority shape and number, never colour alone).
//   - the alarm console (bottom): the server's shared alarm list (ISA-18.2), acknowledged for every operator
//   - the status grid: every station and gauge on one screen, with its key values
//   - the faceplate: a station's P&ID schematic with live values, and the trend of any reading
// It draws from the monitor's station and gauge objects (app.ts keeps them live) and calls back into app.ts to
// open things on the map and in the sidebar.

import type { CardReading, Facility, MeterProps, MonState } from "@/lib/gis/types";
import type { Alarm, AlarmPriority, History } from "@/lib/scada/types";

type Gauge = MeterProps & { lon: number; lat: number };
type Reading = CardReading & { group: string };

export interface ScadaHost {
  root: HTMLElement;
  stations: () => Facility[];
  gauges: () => Gauge[];
  /** the state labels ("Working" …) */
  labels: Record<string, string>;
  openStation: (uid: string) => void;
  openGauge: (uid: string) => void;
  /** opens the pipe of a twin pipe id */
  openPipeOf: (twinId: string) => void;
  /** the stage changed size (the map must be resized) */
  onLayout: () => void;
  /** the city's one-line state (the top bar's system pill) */
  city: () => { state: string; text: string };
  /** an icon (SVG markup): "station", "gauge-psi", "gauge-cl", "pipe" or "group:<equipment group>" */
  icon: (kind: string) => string;
}

export interface Scada {
  /** the station and gauge objects changed (a new live status) */
  update: () => void;
  setAlarms: (list: Alarm[]) => void;
  /** a station's or gauge's faceplate; `trend` = "twinId|property" to show first */
  openFaceplate: (kind: "station" | "gauge", uid: string, trend?: string) => void;
  stop: () => void;
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const PRI_NAME: Record<AlarmPriority, string> = { 1: "High", 2: "Medium", 3: "Low" };
const STATE_PRI: Partial<Record<string, AlarmPriority>> = { down: 1, attention: 2, nodata: 3 };

/** The ISA-18.2 priority indicator: shape + number + colour (1 square, 2 triangle, 3 diamond). */
export function priShape(p: AlarmPriority, size = 16): string {
  const shape = p === 1 ? `<rect x="1.5" y="1.5" width="15" height="15" rx="1.5"/>`
    : p === 2 ? `<path d="M9 1.2 17.2 16.3H.8z"/>` : `<path d="M9 .8 17.2 9 9 17.2.8 9z"/>`;
  return `<svg class="pri p${p}" width="${size}" height="${size}" viewBox="0 0 18 18" role="img" aria-label="Priority ${p} (${PRI_NAME[p]})">` +
    `${shape}<text x="9" y="${p === 2 ? 14 : 12.8}" text-anchor="middle">${p}</text></svg>`;
}

const pad = (n: number) => String(n).padStart(2, "0");
function clock(t: string | number): string {
  const d = new Date(t), now = new Date();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return d.toDateString() === now.toDateString() ? hm : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${hm}`;
}
/** "just now", "12 min", "3 h", "2 d" */
function since(t: string | number): string {
  const m = (Date.now() - new Date(t).getTime()) / 60_000;
  return m < 1 ? "just now" : m < 60 ? `${Math.floor(m)} min` : m < 48 * 60 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 1440)} d`;
}
/** localStorage, quietly (private windows, blocked storage) */
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* not kept */ } },
};
const ICON = {
  map: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3z"/><path d="M9 3v15M15 6v15"/></svg>`,
  grid: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16"/></svg>`,
  bell: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/></svg>`,
  check: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.7 2.7L16 9.8"/></svg>`,
  expand: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>`,
  shrink: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/></svg>`,
  close: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>`,
  chart: `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-6"/></svg>`,
};

/** A trend's figures over [t0, now]: the value held between samples (a step), so the average is time-weighted. */
export function trendStats(d: { t: number[]; v: (number | null)[] }, t0: number, now: number):
  { now: number | null; min: number | null; max: number | null; avg: number | null; n: number } {
  let min: number | null = null, max: number | null = null, area = 0, span = 0, n = 0, last: number | null = null;
  for (let i = 0; i < d.t.length; i++) {
    const v = d.v[i] ?? null;
    const a = Math.max(d.t[i]!, t0), b = Math.min(i + 1 < d.t.length ? d.t[i + 1]! : now, now);
    if (d.t[i]! >= t0) n++;
    last = v;
    if (v == null || b <= a) continue;
    min = min == null ? v : Math.min(min, v);
    max = max == null ? v : Math.max(max, v);
    area += v * (b - a);
    span += b - a;
  }
  return { now: last, min, max, avg: span ? area / span : null, n };
}
const numOf = (r: CardReading | undefined) => {
  if (!r) return null;
  if (r.pct != null) return r.pct;
  const n = parseFloat(r.value);
  return Number.isFinite(n) ? n : null;
};
const unitOf = (r: CardReading) => (r.unit === "lps" ? "L/s" : r.unit === "% open" ? "%" : r.unit ?? "");

/** A station's readings, each with its equipment group. */
const readingsOf = (f: Facility): Reading[] => (f.groups || []).flatMap((g) => g.all.map((r) => ({ ...r, group: g.group })));
function pick(rs: Reading[], prop: string, group?: string, idHas?: string): Reading | undefined {
  return rs.find((r) => r.property === prop && (!group || r.group === group) && (!idHas || (r.twin_id ?? "").includes(idHas)));
}
const keyOf = (r: CardReading | undefined) => (r?.twin_id && r.property ? `${r.twin_id}|${r.property}` : "");

/** ISA-101 analog indicator: a grey scale, the normal range lighter, a black pointer (coloured when abnormal). */
export function analogBar(v: number | null, min: number, max: number, lo: number | null, hi: number | null, abnormal: AlarmPriority | null, w = 160): string {
  const h = 22, x = (n: number) => 1 + ((Math.max(min, Math.min(max, n)) - min) / (max - min)) * (w - 2);
  const band = `<rect class="ab-normal" x="${x(lo ?? min)}" y="5" width="${Math.max(0, x(hi ?? max) - x(lo ?? min))}" height="8"/>`;
  const ptr = v == null ? "" : `<path class="ab-ptr ${abnormal ? `p${abnormal}` : ""}" d="M${x(v)} 13 l-5 8 h10z"/>`;
  return `<svg class="analog" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><rect class="ab-track" x="1" y="5" width="${w - 2}" height="8"/>${band}${ptr}</svg>`;
}

export function startScada(h: ScadaHost): Scada {
  const $ = <T extends HTMLElement = HTMLElement>(sel: string) => h.root.querySelector<T>(sel)!;
  const bar = $("#mainbar"), grid = $("#grid"), face = $("#faceplate"), console_ = $("#alarms");
  let alarms: Alarm[] = [];
  let received = false;               // the server's list has arrived (until then "no alarms" would be untrue)
  let screen: "map" | "grid" = "map";
  let filter: "all" | "unack" | "p1" | "p2" | "p3" = "all";
  let collapsed = false;
  let gridAbnormal = false;
  let fp: { kind: "station" | "gauge"; uid: string; trend: string; hours: number; table: boolean } | null = null;
  let fpExpanded = store.get("scada.fpExpanded") === "1";
  // the console's height, as the operator last dragged it
  const savedH = Number(store.get("scada.consoleH"));
  if (savedH >= 110) console_.style.height = `${savedH}px`;

  // ------------------------------------------------------------ top bar: screens, system state, alarm counts, clock
  function renderBar() {
    const act = alarms.filter((a) => !a.cleared);
    const unack = alarms.filter((a) => !a.acked).length;
    const by = (p: AlarmPriority) => act.filter((a) => a.priority === p).length;
    const c = h.city();
    const cp = STATE_PRI[c.state];
    const short = c.state === "waiting" ? "Connecting…" : c.state === "ok" ? "All systems normal" : (c.text.split(":")[0] || c.text);
    bar.innerHTML = `<div class="screens" role="tablist">` +
      ([["map", "Map", ICON.map], ["grid", "Status grid", ICON.grid]] as const).map(([k, t, i]) =>
        `<button role="tab" aria-selected="${screen === k}" class="${screen === k ? "on" : ""}" data-screen="${k}">${i}${t}</button>`).join("") + `</div>` +
      `<span class="syspill ${cp ? "abn" : ""}" title="${esc(c.text)}">${cp ? priShape(cp, 14) : `<i class="dot"></i>`}${esc(short)}</span>` +
      `<div class="alsum" role="group" aria-label="Active alarms by priority">` +
      ([1, 2, 3] as AlarmPriority[]).map((p) => `<button class="pp ${by(p) ? "" : "zero"} ${filter === `p${p}` && !collapsed ? "on" : ""}" data-pri="${p}" ` +
        `title="Show priority ${p} alarms">${priShape(p, 14)}<b>${by(p)}</b></button>`).join("") +
      `<button class="pp unack ${unack ? "has" : "zero"}" data-act="focus-alarms" title="Show unacknowledged alarms">${ICON.bell}<b>${unack}</b><span>unack</span></button></div>` +
      `<span class="clock"><i class="live"></i><span id="hp-clock">${clockLong()}</span></span>`;
  }
  const clockLong = () => {
    const d = new Date();
    return `${d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} · ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  // ------------------------------------------------------------ alarm console
  function kindIcon(a: Alarm) {
    if (a.kind === "station") return h.icon("station");
    if (a.kind === "pipe") return h.icon("pipe");
    const g = h.gauges().find((x) => x.twin_id === a.source);
    return h.icon(g?.type === "chlorine_point" ? "gauge-cl" : "gauge-psi");
  }
  function renderConsole() {
    const unack = alarms.filter((a) => !a.acked).length;
    const active = alarms.filter((a) => !a.cleared).length;
    const rows = alarms.filter((a) => filter === "all" || (filter === "unack" ? !a.acked : a.priority === Number(filter.slice(1))));
    const head = `<div class="ac-grip" data-act="grip" title="Drag to resize" aria-hidden="true"><i></i></div>` +
      `<div class="ac-head"><button class="ac-toggle" data-act="collapse" aria-expanded="${!collapsed}">` +
      `<svg class="chev" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.6"><path d="${collapsed ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"}"/></svg>` +
      `${ICON.bell}<span>Alarms</span></button>` +
      `<span class="ac-chip">${active} active</span><span class="ac-chip ${unack ? "hot" : ""}">${unack} unacknowledged</span>` +
      `<div class="seg ac-filter" role="group" aria-label="Filter alarms">` +
      ([["all", "All"], ["unack", "Unacknowledged"], ["p1", "Priority 1"], ["p2", "2"], ["p3", "3"]] as const).map(([k, t]) =>
        `<button class="${filter === k ? "on" : ""}" data-filter="${k}">${t}</button>`).join("") + `</div>` +
      `<button class="btn ac-ackall" data-act="ackall" ${unack ? "" : "disabled"}>Acknowledge all</button></div>`;
    if (collapsed) { console_.innerHTML = head; console_.classList.add("collapsed"); return; }
    console_.classList.remove("collapsed");
    const body = rows.length ? `<table class="ac-table"><thead><tr><th></th><th>Raised</th><th>Source</th><th>Alarm</th><th>State</th><th></th></tr></thead><tbody>` +
      rows.map((a) => {
        const st = a.cleared ? (a.acked ? "Cleared" : "RTN") : a.acked ? "ACK" : "UNACK";
        const stTitle = a.cleared ? `Returned to normal at ${clock(a.cleared)}` : a.acked ? `Acknowledged at ${clock(a.acked)}` : "Unacknowledged";
        return `<tr class="${a.acked ? "acked" : "unacked"} ${a.cleared ? "rtn" : ""} p${a.priority}" data-id="${esc(a.id)}">` +
          `<td class="pr">${priShape(a.priority)}</td>` +
          `<td class="tm"><b>${esc(clock(a.raised))}</b><small>${esc(since(a.raised))} ago</small></td>` +
          `<td class="src"><div class="srcw"><span class="ki">${kindIcon(a)}</span><span><b>${esc(a.name)}</b><small>${a.kind === "station" ? "Station" : a.kind === "gauge" ? "Gauge" : "Pipe"}</small></span></div></td>` +
          `<td class="msg">${esc(a.text)}</td>` +
          `<td><span class="spill ${a.cleared ? "rtn" : a.acked ? "ack" : "unack"}" title="${esc(stTitle)}">${st}</span></td>` +
          `<td class="act">${a.acked ? "" : `<button class="btn sm ack" data-ack="${esc(a.id)}">Ack</button>`}</td></tr>`;
      }).join("") + `</tbody></table>`
      : !received ? `<div class="ac-empty">${ICON.bell}<div><b>Waiting for the alarm list</b><span>It arrives with the first status from the digital twin.</span></div></div>`
      : `<div class="ac-empty">${ICON.check}<div><b>${alarms.length ? "No alarms match this filter" : "No alarms"}</b>` +
        `<span>${alarms.length ? "Choose another filter to see the rest." : "Every station and gauge is normal."}</span></div></div>`;
    const keep = console_.querySelector(".ac-body")?.scrollTop ?? 0;
    console_.innerHTML = head + `<div class="ac-body">${body}</div>`;
    console_.querySelector(".ac-body")!.scrollTop = keep;
  }
  // drag the console's top edge: taller or shorter (110 px to 70% of the main area), remembered
  let drag: { y: number; h: number } | null = null;
  let raf = 0;
  const onGripDown = (e: PointerEvent) => {
    if (!(e.target as HTMLElement).closest("[data-act=grip]") || collapsed) return;
    e.preventDefault();
    drag = { y: e.clientY, h: console_.getBoundingClientRect().height };
    document.body.classList.add("resizing");
  };
  const onGripMove = (e: PointerEvent) => {
    if (!drag) return;
    const max = (console_.parentElement?.getBoundingClientRect().height ?? 800) * 0.7;
    const hh = Math.round(Math.min(max, Math.max(110, drag.h + drag.y - e.clientY)));
    console_.style.height = `${hh}px`;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => h.onLayout());
  };
  const onGripUp = () => {
    if (!drag) return;
    drag = null;
    document.body.classList.remove("resizing");
    store.set("scada.consoleH", String(Math.round(console_.getBoundingClientRect().height)));
    h.onLayout();
  };
  async function ack(ids: string[] | "all") {
    try {
      await fetch("/api/alarms/ack", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ids === "all" ? { all: true } : { ids }) });
    } catch { /* the stream brings the list back as it is */ }
  }
  function openSource(a: Alarm) {
    if (a.kind === "station") {
      const f = h.stations().find((s) => s.twin_id === a.source);
      if (f) { h.openStation(f.uid); openFaceplate("station", f.uid); }
    } else if (a.kind === "gauge") {
      const g = h.gauges().find((x) => x.twin_id === a.source);
      if (g) { h.openGauge(g.uid); openFaceplate("gauge", g.uid); }
    } else h.openPipeOf(a.source);
  }

  // ------------------------------------------------------------ status grid
  function cell(r: Reading | undefined, digits = 1): string {
    if (!r) return `<td class="na">—</td>`;
    if (r.offline) return `<td class="comm" title="Sensor not reporting">COMM</td>`;
    const n = numOf(r);
    const shown = n != null && r.value !== "yes" && r.value !== "no" ? `${n.toFixed(digits)}` : esc(r.value);
    const pri = r.alarm ? 2 : null;
    return `<td class="v ${pri ? "abn" : ""}" data-trend="${esc(keyOf(r))}" title="${esc(r.name)}${r.alarm ? `: ${esc(r.alarm)}` : ""}">` +
      `${pri ? priShape(pri, 13) : ""}${shown}</td>`;
  }
  function stateCell(st: MonState | null | undefined, standby: boolean): string {
    const p = STATE_PRI[st ?? ""];
    return `<td class="state"><span class="spill ${p ? `abn p${p}` : ""}">${p ? priShape(p, 12) : ""}${esc(standby && st === "ok" ? "Standby" : h.labels[st ?? ""] ?? "—")}</span></td>`;
  }
  const isRunning = (f: Facility) => {
    const rs = readingsOf(f);
    const run = pick(rs, "run_status"), speed = pick(rs, "speed_hz", "vfd");
    return run ? /run|on/i.test(run.value) : speed ? (numOf(speed) ?? 0) > 0 : null;
  };
  /** The headline tiles over the grid: a big number, its label and one line; a shape only when it is bad. */
  function kpis(ss: Facility[], dpps: Gauge[]): string {
    const pumps = ss.map(isRunning).filter((x): x is boolean => x != null);
    const running = pumps.filter(Boolean).length, standby = ss.filter((f) => f.standby).length;
    const down = ss.filter((f) => f.state === "down").length;
    const reporting = dpps.filter((g) => g.psi != null && g.state !== "nodata");
    const low = reporting.filter((g) => g.psi! < 7), veryLow = low.filter((g) => g.psi! < 3);
    const lowest = reporting.reduce<Gauge | null>((a, g) => (!a || g.psi! < a.psi! ? g : a), null);
    const tanks = ss.map((f) => pick(readingsOf(f), "level_pct", "storage")).filter((r): r is Reading => !!r && !r.offline);
    const tanksLow = tanks.filter((r) => r.alarm);
    const minTank = tanks.reduce<number | null>((m, r) => { const n = numOf(r); return n == null ? m : m == null ? n : Math.min(m, n); }, null);
    const act = alarms.filter((a) => !a.cleared);
    const byP = (p: number) => act.filter((a) => a.priority === p).length;
    const worstP = ([1, 2, 3] as AlarmPriority[]).find((p) => byP(p));
    const tile = (big: string, of: string, label: string, sub: string, p: AlarmPriority | null | undefined) =>
      `<button class="kpi ${p ? `abn p${p}` : ""}" data-act="kpi"><span class="k-l">${p ? priShape(p, 14) : ""}${label}</span>` +
      `<span class="k-v">${big}<small>${of}</small></span><span class="k-s">${sub}</span></button>`;
    return `<div class="kpis">` +
      tile(`${running}`, ` / ${pumps.length}`, "Pumps running", `${standby} on standby${down ? ` · ${down} station${down > 1 ? "s" : ""} not working` : ""}`, down ? 1 : null) +
      tile(`${low.length}`, ` / ${reporting.length}`, "Pressure points below 7 psi",
        lowest ? `lowest ${lowest.psi} psi · ${esc(lowest.name)}` : "no readings", veryLow.length ? 1 : low.length ? 2 : null) +
      tile(`${tanksLow.length}`, ` / ${tanks.length}`, "Storage tanks below minimum", minTank != null ? `lowest level ${minTank}%` : "no readings", tanksLow.length ? 2 : null) +
      tile(`${act.length}`, "", "Active alarms", `P1 ${byP(1)} · P2 ${byP(2)} · P3 ${byP(3)}`, worstP) + `</div>`;
  }
  function renderGrid() {
    if (screen !== "grid") return;
    const ss = h.stations().filter((f) => f.twin_id).sort((a, b) => a.name.localeCompare(b.name));
    const shown = gridAbnormal ? ss.filter((f) => f.state && f.state !== "ok") : ss;
    const gs = h.gauges().filter((g) => g.twin_id);
    const allDpps = gs.filter((g) => g.type === "pressure_logger");
    const dpps = allDpps.filter((g) => !gridAbnormal || (g.state && g.state !== "ok")).sort((a, b) => a.name.localeCompare(b.name));
    const chl = gs.filter((g) => g.type === "chlorine_point").filter((g) => !gridAbnormal || (g.state && g.state !== "ok")).sort((a, b) => a.name.localeCompare(b.name));
    let html = kpis(ss, allDpps) + `<div class="g-tools"><label class="switch"><input type="checkbox" data-act="abn" ${gridAbnormal ? "checked" : ""}><i></i>Abnormal only</label>` +
      `<span class="g-note">Grey is normal; a shape and number mark anything abnormal. Click a row for its faceplate, a value for its trend.</span></div>`;
    html += `<section class="card"><header class="card-h">${h.icon("station")}<span>Pumping stations and bulk supply</span><em>${shown.length}</em></header>` +
      `<div class="g-scroll"><table class="g-table"><thead><tr>` +
      `<th>Station</th><th>State</th><th>Pump</th><th>VFD Hz</th><th class="div">Tank %</th><th></th><th class="div">Outlet psi</th><th>Outlet L/s</th><th>Cl₂ ppm</th><th class="div">Power</th><th>Gen fuel %</th><th class="div">Issues</th></tr></thead><tbody>` +
      shown.map((f) => {
        const rs = readingsOf(f);
        const speed = pick(rs, "speed_hz", "vfd"), run = pick(rs, "run_status");
        const running = run ? /run|on/i.test(run.value) : (numOf(speed) ?? 0) > 0;
        const pump = !speed && !run ? `<td class="na">—</td>` : `<td class="${f.groups.find((g) => g.group === "pumping")?.state === "down" ? "abn" : ""}">${running ? "Running" : f.standby ? "Standby" : "Stopped"}</td>`;
        const tank = pick(rs, "level_pct", "storage");
        const tankN = numOf(tank);
        const flow = pick(rs, "flow_lps", "storage") ?? pick(rs, "flow_lps");
        const n = (f.issues || []).length;
        // a station pumping around its tank shows that instead of the tank level
        const tankCells = f.bypass
          ? `<td class="v abn" title="Storage tank bypassed (${f.bypass === "tank-out" ? "tank out of service" : "tank inlet closed"}): pumping direct to the network">` +
            `${priShape(2, 13)}Bypassed</td><td class="abcell"></td>`
          : `${cell(tank, 0)}<td class="abcell">${tank && !tank.offline ? analogBar(tankN, 0, 100, 25, 100, tank.alarm ? 2 : null, 90) : ""}</td>`;
        return `<tr data-station="${esc(f.uid)}"><th>${esc(f.name)}</th>${stateCell(f.state, f.standby)}${pump}${cell(speed, 0)}${tankCells}` +
          `${cell(pick(rs, "pressure_psi", "storage") ?? pick(rs, "pressure_psi"))}${cell(flow)}${cell(pick(rs, "chlorine_residual_ppm"), 2)}` +
          `${cell(pick(rs, "power_source"))}${cell(pick(rs, "fuel_level_pct"), 0)}<td class="${n ? "abn" : "na"}">${n || "—"}</td></tr>`;
      }).join("") + `</tbody></table></div></section>`;
    const tile = (g: Gauge, kind: "psi" | "ppm") => {
      const v = kind === "psi" ? g.psi : g.chlorine;
      const p = STATE_PRI[g.state ?? ""] ?? null;
      const bar = kind === "psi" ? analogBar(v, 0, 60, 7, 60, p, 150) : analogBar(v, 0, 2, 0.3, 1.5, p, 150);
      return `<button class="g-tile ${p ? "abn" : ""}" data-gauge="${esc(g.uid)}" title="${esc(g.headline || "")}">` +
        `<span class="gt-n">${p ? priShape(p, 13) : ""}${esc(g.name)}</span>` +
        `<span class="gt-v">${v != null && g.state !== "nodata" ? `${v}<small> ${kind}</small>` : `<span class="comm">${g.status === "offline" ? "COMM" : "—"}</span>`}</span>${bar}</button>`;
    };
    html += `<section class="card"><header class="card-h">${h.icon("gauge-psi")}<span>Designated pressure points</span><em>${dpps.length}</em><small>normal 7 psi and up</small></header>` +
      `<div class="g-tiles">${dpps.map((g) => tile(g, "psi")).join("")}</div></section>`;
    if (chl.length) html += `<section class="card"><header class="card-h">${h.icon("gauge-cl")}<span>Far-point chlorine</span><em>${chl.length}</em><small>normal 0.3 – 1.5 ppm</small></header>` +
      `<div class="g-tiles">${chl.map((g) => tile(g, "ppm")).join("")}</div></section>`;
    const keep = grid.scrollTop;
    grid.innerHTML = html;
    grid.scrollTop = keep;
  }

  // ------------------------------------------------------------ faceplate: the station's P&ID and trends
  function instrument(x: number, y: number, tag: string, r: Reading | undefined, digits = 1, below = true): string {
    if (!r) return "";
    const n = numOf(r);
    const val = r.offline ? "COMM" : n != null ? `${n.toFixed(digits)} ${unitOf(r)}`.trim() : r.value;
    const abn = r.alarm || r.offline;
    const vy = below ? y + 30 : y - 42;
    return `<g class="hot ${abn ? "abn" : ""}" data-trend="${esc(keyOf(r))}"><title>${esc(r.name)}${r.alarm ? `: ${esc(r.alarm)}` : ""}</title>` +
      `<circle class="bubble" cx="${x}" cy="${y}" r="16"/><text class="tag" x="${x}" y="${y + 4}">${tag}</text>` +
      `<rect class="vbox ${r.offline ? "comm" : ""}" x="${x - 38}" y="${vy}" width="76" height="20" rx="2"/>` +
      `<text class="val" x="${x}" y="${vy + 14}">${esc(val)}</text>` +
      // the alarm flag on the bubble's free side (away from the value box)
      (abn ? `<g transform="translate(${below ? x - 31 : x + 15} ${below ? y - 26 : y + 9})">${priShape(r.offline ? 3 : 2, 16)}</g>` : "") + `</g>`;
  }
  const flag = (x: number, y: number, st: MonState | undefined) => {
    const p = STATE_PRI[st ?? ""];
    return p ? `<g transform="translate(${x} ${y})">${priShape(p, 18)}</g>` : "";
  };
  const valve = (x: number, y: number, r: Reading | undefined, label: string) => {
    const pos = numOf(r);
    const open = pos == null ? null : pos > 0;
    return `<g class="hot ${r?.alarm ? "abn" : ""}" ${r ? `data-trend="${esc(keyOf(r))}"` : ""}><title>${esc(label)}${pos != null ? `: ${pos}% open` : ""}</title>` +
      `<path class="valve ${open ? "on" : ""}" d="M${x - 13} ${y - 10} L${x + 13} ${y + 10} L${x + 13} ${y - 10} L${x - 13} ${y + 10} Z"/>` +
      `<text class="lbl" x="${x}" y="${y - 18}">${esc(label)}</text>` +
      `<text class="val sm" x="${x}" y="${y + 28}">${r?.offline ? "COMM" : pos != null ? `${pos}% open` : ""}</text></g>`;
  };

  function mimic(f: Facility): string {
    const rs = readingsOf(f);
    const G = new Map((f.groups || []).map((g) => [g.group, g.state]));
    const speed = pick(rs, "speed_hz", "vfd"), current = pick(rs, "current_a", "vfd"), fault = pick(rs, "fault_code", "vfd");
    // the twin keeps the supply voltage and the motor current on the VFD; the schematic shows them on a control panel
    // ahead of it (a panel's voltmeter and ammeter), as a station is wired: ATS -> control panel -> VFD -> pump
    const volts = pick(rs, "supply_voltage_v", "vfd") ?? pick(rs, "supply_voltage_v");
    const run = pick(rs, "run_status");
    const running = run ? /run|on/i.test(run.value) : (numOf(speed) ?? 0) > 0;
    const flowing = running || (numOf(pick(rs, "flow_lps", "storage")) ?? 0) > 0;
    const bulk = f.kind === "bulk";
    const tankR = pick(rs, "level_pct", "storage");
    const level = numOf(tankR);
    // water moving along a live pipe (a dash running down the line) and a turning ring on a running pump. The schematic
    // is redrawn with every update, so each animation starts at the phase the clock gives it: it carries on, no jump
    const phase = (s: number) => `animation-delay:-${((Date.now() % (s * 1000)) / 1000).toFixed(3)}s`;
    const flow = (d: string, cls = "flow") => `<path class="${cls}" d="${d}" style="${phase(1)}"/>`;
    const spin = (cx: number, cy: number, r: number) => `<circle class="spin" cx="${cx}" cy="${cy}" r="${r}" style="${phase(2)}"/>`;
    const pipe = (d: string, on = flowing) => `<path class="pipe ${on ? "on" : ""}" d="${d}"/>` + (on ? flow(d) : "");
    let s = `<svg class="pid" viewBox="0 0 1000 390" text-anchor="middle" role="img" aria-label="Process schematic of ${esc(f.name)}">`;
    // ---- source: a well with its submersible pump, or a bulk supply point
    if (bulk) {
      s += `<rect class="equip" x="30" y="122" width="110" height="56" rx="3"/><text class="lbl" x="85" y="146">BULK SUPPLY</text>` +
        `<text class="sub" x="85" y="164">${esc(f.name)}</text>` + flag(118, 104, G.get("source"));
      s += instrument(205, 150, "FT", pick(rs, "flow_lps", "source"), 1, false) + instrument(275, 150, "AIT", pick(rs, "chlorine_residual_ppm", "source"), 2, false);
      s += pipe("M140 150 H 520");
    } else {
      s += `<path class="casing" d="M68 112 V 330 M112 112 V 330"/><text class="lbl" x="90" y="352">WELL</text>` + flag(118, 300, G.get("source"));
      s += `<g class="hot" ${run ? `data-trend="${esc(keyOf(run))}"` : ""}><title>Submersible pump: ${running ? "running" : "stopped"}</title>` +
        (running ? spin(90, 285, 25) : "") +
        `<circle class="pump ${running ? "on" : ""}" cx="90" cy="285" r="19"/><path class="pump-tri ${running ? "on" : ""}" d="M90 270 L104 292 H76 Z"/></g>` +
        `<text class="lbl" x="122" y="322" text-anchor="start">PUMP</text><text class="sub" x="122" y="337" text-anchor="start">${running ? "Running" : f.standby ? "Standby" : "Stopped"}</text>` +
        flag(118, 252, G.get("pumping"));
      s += pipe("M90 266 V 150 H 520");
      // the pump drive, wired to the pump
      if (speed || current || fault) {
        s += `<line class="elec ${running ? "on" : ""}" x1="109" y1="285" x2="200" y2="285"/>` +
          `<rect class="equip" x="200" y="252" width="130" height="62" rx="3"/><text class="lbl" x="265" y="269">VFD</text>` +
          `<g class="hot" ${speed ? `data-trend="${esc(keyOf(speed))}"` : ""}><title>VFD output frequency</title>` +
          `<text class="val" x="265" y="290">${speed ? (speed.offline ? "COMM" : `${numOf(speed) ?? "—"} Hz`) : ""}</text></g>` +
          `<text class="sub ${fault && !/none|ok|^0$/i.test(fault.value) ? "abn-t" : ""}" x="265" y="307">${fault ? `fault: ${esc(fault.value)}` : ""}</text>` + flag(322, 244, G.get("vfd"));
      }
      // the control panel: its voltmeter and ammeter (the VFD twin's supply voltage and current)
      if (volts || current) {
        const meter = (x: number, r: Reading | undefined, unit: string, tag: string) => {
          const abn = r?.alarm || r?.offline;
          return `<g class="hot ${abn ? "abn" : ""}" ${r ? `data-trend="${esc(keyOf(r))}"` : ""}>` +
            `<title>${tag === "V" ? "Voltmeter: supply voltage" : "Ammeter: motor current"} (read from the VFD twin)${r?.alarm ? `: ${esc(r.alarm)}` : ""}</title>` +
            `<circle class="bubble" cx="${x}" cy="279" r="11"/><text class="tag" x="${x}" y="283">${tag}</text>` +
            `<rect class="vbox ${r?.offline ? "comm" : ""}" x="${x - 30}" y="294" width="60" height="17" rx="2"/>` +
            `<text class="val sm" x="${x}" y="306">${r ? (r.offline ? "COMM" : `${numOf(r) ?? "—"} ${unit}`) : "—"}</text>` +
            (abn ? `<g transform="translate(${x + 9} ${265})">${priShape(r?.offline ? 3 : 2, 13)}</g>` : "") + `</g>`;
        };
        s += `<line class="elec on" x1="360" y1="270" x2="330" y2="270"/>` +
          `<rect class="equip" x="360" y="252" width="130" height="62" rx="3"/><text class="lbl" x="425" y="264">CONTROL PANEL</text>` +
          meter(395, volts, "V", "V") + meter(455, current, "A", "A");
      }
      s += instrument(190, 150, "PT", pick(rs, "pressure_psi", "pumping"), 1, false) + instrument(255, 150, "FT", pick(rs, "flow_lps", "pumping"), 1, false);
    }
    // ---- chlorination: chlorine tank, dosing pump, injection into the line
    const dose = pick(rs, "dosing_flow_lph"), clTank = pick(rs, "level_pct", "treatment");
    if (dose || clTank) {
      const dosing = (numOf(dose) ?? 0) > 0;
      s += `<rect class="equip" x="345" y="16" width="44" height="62" rx="4"/>` +
        (clTank && numOf(clTank) != null ? `<rect class="fill" x="347" y="${18 + 58 * (1 - Math.min(100, numOf(clTank)!) / 100)}" width="40" height="${58 * Math.min(100, numOf(clTank)!) / 100}"/>` : "") +
        `<g class="hot ${clTank?.alarm ? "abn" : ""}" ${clTank ? `data-trend="${esc(keyOf(clTank))}"` : ""}><text class="val sm" x="367" y="95">${clTank ? (clTank.offline ? "COMM" : `${numOf(clTank)}%`) : ""}</text></g>` +
        `<text class="lbl" x="367" y="10">Cl₂ TANK</text>` +
        `<line class="dose ${dosing ? "on" : ""}" x1="389" y1="47" x2="430" y2="47"/>` + (dosing ? flow("M389 47 H 430", "flow thin") : "") +
        `<g class="hot" ${dose ? `data-trend="${esc(keyOf(dose))}"` : ""}><title>Chlorine dosing pump</title>${dosing ? spin(445, 47, 18) : ""}<circle class="pump ${dosing ? "on" : ""}" cx="445" cy="47" r="13"/></g>` +
        `<text class="val sm" x="445" y="25">${dose ? (dose.offline ? "COMM" : `${numOf(dose)} L/h`) : ""}</text>` +
        `<path class="dose ${dosing ? "on" : ""}" d="M445 60 V 150"/>` + (dosing ? flow("M445 60 V 150", "flow thin") : "") +
        `<circle class="inj" cx="445" cy="150" r="4"/>` + flag(468, 22, G.get("treatment"));
    }
    // ---- the tank bypass: stations have one (the twin does not); drawn closed, and as the live path when the station
    // pumps around its tank (f.bypass, lib/monitor/status.ts stationBypass)
    const by = f.bypass ?? null;
    const tankFlow = flowing && !by;
    const TANK = "M600 84 Q600 60 675 60 Q750 60 750 84 V272 Q750 280 742 280 H608 Q600 280 600 272 Z";
    s += `<defs><pattern id="pid-hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
      `<line class="hatch" x1="0" y1="0" x2="0" y2="8"/></pattern></defs>`;
    s += `<g class="bypass-g ${by ? "on" : ""}"><title>Tank bypass line (not in the digital twin). ` +
      `Shown open when the storage tank is out of service, or its inlet is closed while water still leaves the station.</title>` +
      `<path class="${by ? "pipe on" : "bypass"}" d="M500 150 V 22 H 764 V 250"/>` + (by ? flow("M500 150 V 22 H 764 V 250") : "") +
      `<path class="valve ${by ? "on" : ""}" d="M623 12 L649 32 L649 12 L623 32 Z"/>` +
      `<text class="lbl" x="614" y="15" text-anchor="end">BYPASS</text>` +
      `<text class="sub ${by ? "abn-t" : ""}" x="614" y="36" text-anchor="end">${by ? "OPEN" : "closed"}</text>` +
      `<circle class="inj" cx="500" cy="150" r="3.5"/><circle class="inj" cx="764" cy="250" r="3.5"/></g>`;
    // ---- storage: inlet valve, tank with level, outlet valve
    s += valve(530, 150, pick(rs, "valve_position_pct_open", "storage", "inlet"), "INLET");
    s += pipe("M543 150 H 600", tankFlow);
    s += `<g class="hot ${tankR?.alarm ? "abn" : ""}" ${tankR ? `data-trend="${esc(keyOf(tankR))}"` : ""}><title>Storage tank${level != null ? `: ${level}%` : ""}${by ? " (bypassed)" : ""}</title>` +
      `<path class="equip tank ${by ? "oos" : ""}" d="${TANK}"/>` +
      (level != null && !tankR?.offline ? `<rect class="fill ${by ? "oos" : ""}" x="603" y="${86 + 191 * (1 - Math.min(100, level) / 100)}" width="144" height="${191 * Math.min(100, level) / 100}" rx="4"/>` : "") +
      (by ? `<path class="tank-hatch" d="${TANK}"/>` : "") +
      `<text class="lbl" x="675" y="52">STORAGE TANK</text>` +
      `<rect class="vbox" x="635" y="150" width="80" height="26" rx="2"/><text class="val big" x="675" y="169">${tankR ? (tankR.offline ? "COMM" : `${level ?? "—"} %`) : "—"}</text>` +
      (by ? `<rect class="oos-tag" x="611" y="190" width="128" height="22" rx="3"/><text class="oos-t" x="675" y="205">${by === "tank-out" ? "OUT OF SERVICE" : "INLET CLOSED"}</text>` : "") +
      `</g>` + flag(604, 38, G.get("storage"));
    // the outlet: valve, then pressure, flow and chlorine, values alternating below / above the line
    s += pipe("M750 250 H 764", tankFlow) + pipe("M764 250 H 778");
    s += valve(791, 250, pick(rs, "valve_position_pct_open", "storage", "outlet"), "OUTLET");
    s += pipe("M804 250 H 975");
    s += instrument(855, 250, "PT", pick(rs, "pressure_psi", "storage"), 1, true) + instrument(908, 250, "FT", pick(rs, "flow_lps", "storage"), 1, false) +
      instrument(958, 250, "AIT", pick(rs, "chlorine_residual_ppm", "storage"), 2, true);
    s += `<path class="arrow ${flowing ? "on" : ""}" d="M975 240 L992 250 L975 260 Z"/><text class="lbl" x="992" y="330" text-anchor="end">TO NETWORK</text>` +
      (f.affects ? `<text class="sub" x="992" y="346" text-anchor="end">${esc(f.affects.split(", ").slice(0, 3).join(", "))}</text>` : "");
    // ---- power: grid, generator, transfer switch, to the drive
    const present = pick(rs, "power_present"), source = pick(rs, "power_source"), fuel = pick(rs, "fuel_level_pct");
    // ---- power, one row under the drive: transfer switch (ATS) <- grid, <- generator; the ATS feeds the drive
    if (present || source || fuel) {
      const onGen = /gen/i.test(source?.value ?? "");
      const Y = 336, Hh = 42;
      s += `<rect class="equip" x="215" y="${Y}" width="100" height="${Hh}" rx="3"/><text class="lbl" x="265" y="${Y + 16}">ATS</text>` +
        `<text class="sub" x="265" y="${Y + 33}">on ${esc(source?.value ?? "—")}</text>`;
      // the ATS feeds the control panel (or the drive directly when the station has no panel meters)
      if (!bulk && (volts || current)) s += `<path class="elec on" d="M265 ${Y} V 325 H 425 V 314"/>`;
      else if (!bulk && (speed || fault)) s += `<line class="elec on" x1="265" y1="314" x2="265" y2="${Y}"/>`;
      s += `<line class="elec ${onGen ? "" : "on"}" x1="315" y1="${Y + 21}" x2="355" y2="${Y + 21}"/>` +
        `<rect class="equip ${present?.value === "no" ? "abn-box" : ""}" x="355" y="${Y}" width="120" height="${Hh}" rx="3"/><text class="lbl" x="415" y="${Y + 16}">GRID</text>` +
        `<text class="val sm" x="415" y="${Y + 33}">${present ? (present.value === "yes" ? "Power on" : "POWER OFF") : ""}</text>` +
        flag(467, Y - 9, G.get("grid"));
      s += `<path class="elec ${onGen ? "on" : ""}" d="M560 ${Y + Hh} V ${Y + Hh + 8} H 290 V ${Y + Hh}"/>` +
        `<rect class="equip" x="500" y="${Y}" width="120" height="${Hh}" rx="3"/><text class="lbl" x="560" y="${Y + 16}">GENERATOR</text>` +
        `<g class="hot ${fuel?.alarm ? "abn" : ""}" ${fuel ? `data-trend="${esc(keyOf(fuel))}"` : ""}><text class="val sm" x="560" y="${Y + 33}">${fuel ? (fuel.offline ? "COMM" : `fuel ${numOf(fuel)}%`) : ""}</text></g>` +
        flag(612, Y - 9, G.get("generator"));
    }
    s += `</svg>`;
    return s + `<div class="pid-key"><span><i class="k-on"></i>Running / open</span><span><i class="k-off"></i>Stopped / closed</span>` +
      `<span>${priShape(1, 13)}${priShape(2, 13)}${priShape(3, 13)} Alarm priority</span><span class="hint">Click an instrument for its trend</span></div>`;
  }

  // ---- trends
  const histCache = new Map<string, { at: number; data: History }>();
  async function loadHistory(key: string, hours: number): Promise<History | null> {
    const ck = `${key}|${hours}`;
    const c = histCache.get(ck);
    if (c && Date.now() - c.at < 10_000) return c.data;
    const [id, prop] = key.split("|");
    try {
      const r = await fetch(`/api/history?id=${encodeURIComponent(id!)}&prop=${encodeURIComponent(prop!)}&hours=${hours}`);
      if (!r.ok) return null;
      const data = (await r.json()) as History;
      histCache.set(ck, { at: Date.now(), data });
      return data;
    } catch { return null; }
  }
  function niceTicks(lo: number, hi: number, n = 4): number[] {
    const span = hi - lo || 1, step0 = span / n, mag = 10 ** Math.floor(Math.log10(step0));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? mag * 10;
    const out: number[] = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Number(v.toFixed(6)));
    return out;
  }
  function trendSvg(d: History, hours: number, limits: { lo: number | null; hi: number | null }, unit: string): { svg: string; y: (v: number) => number } {
    const W = 860, H = 236, L = 46, R = 14, T = 22, B = 26;
    const now = Date.now(), t0 = now - hours * 3.6e6;
    const vals = d.v.filter((v): v is number => v != null);
    const yl = [...vals, ...(limits.lo != null ? [limits.lo] : []), ...(limits.hi != null ? [limits.hi] : [])];
    let lo = Math.min(...yl), hi = Math.max(...yl);
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
    const padY = (hi - lo) * 0.1; lo = Math.max(lo >= 0 ? 0 : -Infinity, lo - padY); hi += padY;
    const x = (t: number) => L + ((t - t0) / (now - t0)) * (W - L - R);
    const y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const yt = niceTicks(lo, hi);
    let s = `<svg class="trend" viewBox="0 0 ${W} ${H}" role="img" aria-label="Trend">`;
    s += yt.map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join("");
    const stepH = hours <= 1 ? 0.25 : hours <= 8 ? 1 : hours <= 24 ? 4 : 24;
    for (let t = Math.ceil(t0 / (stepH * 3.6e6)) * stepH * 3.6e6; t <= now; t += stepH * 3.6e6) {
      const dd = new Date(t);
      const lab = stepH >= 24 ? dd.toLocaleDateString([], { month: "short", day: "numeric" }) : `${pad(dd.getHours())}:${pad(dd.getMinutes())}`;
      s += `<text class="axis" x="${x(t)}" y="${H - 8}" text-anchor="middle">${lab}</text>`;
    }
    const lim = (v: number | null, name: string) => v == null || v < lo || v > hi ? "" :
      `<line class="limit" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="limit-t" x="${W - R - 4}" y="${y(v) - 5}" text-anchor="end">${name} ${v} ${esc(unit)}</text>`;
    s += lim(limits.lo, "Low limit") + lim(limits.hi, "High limit");
    s += unit ? `<text class="axis unit" x="${L - 6}" y="${T - 2}" text-anchor="end">${esc(unit)}</text>` : "";
    // the line, broken where the sensor was offline; each value held until the next sample (a step); a soft area
    // under each unbroken run
    const base = y(lo).toFixed(1);
    let path = "", area = "", seg = "", segX0 = 0, pen = false, lastPt: [number, number] | null = null;
    const close = () => { if (seg) area += `${seg}V${base}H${segX0.toFixed(1)}Z`; seg = ""; };
    for (let i = 0; i < d.t.length; i++) {
      const v = d.v[i], t = Math.max(d.t[i]!, t0);
      // a gap: the line stops where the sensor went offline
      if (v == null) { if (pen) { path += `H${x(t).toFixed(1)}`; seg += `H${x(t).toFixed(1)}`; } pen = false; close(); continue; }
      const px = x(t).toFixed(1), py = y(v).toFixed(1);
      if (!pen) { path += `M${px} ${py}`; seg = `M${px} ${py}`; segX0 = x(t); pen = true; }
      else { path += `H${px}V${py}`; seg += `H${px}V${py}`; }
      if (i === d.t.length - 1) { path += `H${x(now).toFixed(1)}`; seg += `H${x(now).toFixed(1)}`; lastPt = [x(now), y(v)]; }
    }
    close();
    s += `<path class="area" d="${area}"/><path class="line" d="${path}"/>`;
    const lastV = d.v.at(-1);
    if (lastPt && lastV != null)
      s += `<circle class="end" cx="${lastPt[0]}" cy="${lastPt[1]}" r="4"/>` +
        `<text class="end-t" x="${lastPt[0] - 8}" y="${lastPt[1] - 9}" text-anchor="end">${lastV} ${esc(unit)}</text>`;
    s += `<line class="cross" x1="0" x2="0" y1="${T}" y2="${H - B}" style="display:none"/><circle class="cross-dot" r="4" style="display:none"/>`;
    s += `<rect class="hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}"/></svg>`;
    return { svg: s, y };
  }
  async function renderTrend() {
    if (!fp) return;
    const box = face.querySelector<HTMLElement>(".fp-trend");
    if (!box) return;
    const key = fp.trend, hours = fp.hours;
    const info = trendInfo(key);
    const d = key ? await loadHistory(key, hours) : null;
    if (!fp || fp.trend !== key || fp.hours !== hours) return;
    const head = `<header class="card-h">${ICON.chart.replace('width="26" height="26"', 'width="15" height="15"')}<span>Trend</span><small>${esc(info.name)}</small>` +
      `<div class="seg ranges" role="group" aria-label="Time range">` +
      ([[1, "1 h"], [8, "8 h"], [24, "24 h"], [168, "7 d"]] as const).map(([hh, t]) => `<button class="${hours === hh ? "on" : ""}" data-hours="${hh}">${t}</button>`).join("") +
      `</div><button class="btn sm ghost" data-act="table">${fp.table ? "Chart" : "Table"}</button></header>`;
    // the header (title, time ranges, table) is kept while it shows the same thing, so its buttons are not replaced
    // under the pointer by a live redraw; only what is below it is
    const hk = `${key}|${hours}|${fp.table}`;
    const setBody = (html: string) => {
      const h0 = box.querySelector(":scope > header.card-h");
      if (box.dataset.hk === hk && h0) { while (h0.nextSibling) h0.nextSibling.remove(); h0.insertAdjacentHTML("afterend", html); }
      else { box.innerHTML = head + html; box.dataset.hk = hk; }
    };
    if (!d || !d.t.length || d.v.every((v) => v == null)) {
      setBody(`<div class="tr-empty">${ICON.chart}<div><b>${d ? "No samples in this time range yet" : "The history could not be loaded"}</b>` +
        `<span>${d ? "The server records every reading while the monitor is open (every few seconds, kept 7 days), so the trend fills in from now on." : "It will try again with the next update."}</span></div></div>`);
      return;
    }
    const nowMs = Date.now();
    const st = trendStats(d, nowMs - hours * 3.6e6, nowMs);
    const fmt = (v: number | null) => (v == null ? "—" : `${Number(v.toFixed(2))}`);
    const stats = `<div class="tr-stats">` + ([["Now", st.now == null ? (info.now.includes("offline") ? "COMM" : "—") : fmt(st.now)], ["Min", fmt(st.min)],
      ["Max", fmt(st.max)], ["Average", fmt(st.avg)], ["Samples", `${st.n}`]] as const)
      .map(([k, v], i) => `<div><span>${k}</span><b>${v}${i < 4 && v !== "—" && v !== "COMM" ? `<small> ${esc(info.unit)}</small>` : ""}</b></div>`).join("") + `</div>`;
    if (fp.table) {
      const rows = d.t.map((t, i) => [t, d.v[i]] as const).filter(([t]) => t >= Date.now() - hours * 3.6e6).reverse().slice(0, 200);
      setBody(stats + `<div class="tr-table"><table><thead><tr><th>Time</th><th>Value</th></tr></thead><tbody>` +
        rows.map(([t, v]) => `<tr><td>${esc(clock(t))}</td><td>${v == null ? "offline" : `${v} ${esc(info.unit)}`}</td></tr>`).join("") + `</tbody></table></div>`);
      return;
    }
    const chart = trendSvg(d, hours, info.limits, info.unit);
    setBody(stats + `<div class="tr-plot">${chart.svg}<div class="tip" hidden></div></div>`);
    const svg = box.querySelector<SVGSVGElement>("svg.trend")!, tip = box.querySelector<HTMLElement>(".tip")!;
    const cross = svg.querySelector<SVGLineElement>(".cross")!, dot = svg.querySelector<SVGCircleElement>(".cross-dot")!;
    const W = 860, L = 46, R = 14, now = Date.now(), t0 = now - hours * 3.6e6;
    svg.querySelector(".hit")!.addEventListener("mousemove", (e) => {
      const r = svg.getBoundingClientRect();
      const vx = ((e as MouseEvent).clientX - r.left) / r.width * W;
      const t = t0 + ((vx - L) / (W - L - R)) * (now - t0);
      let i = d.t.findIndex((tt) => tt > t) - 1;
      if (i < 0) i = d.t[0]! > t ? -1 : d.t.length - 1;
      const v = i >= 0 ? d.v[i] : null;
      cross.setAttribute("x1", String(vx)); cross.setAttribute("x2", String(vx)); cross.style.display = "";
      if (v != null) {
        dot.setAttribute("cx", String(vx)); dot.setAttribute("cy", String(chart.y(v))); dot.style.display = "";
      } else dot.style.display = "none";
      tip.hidden = false;
      tip.textContent = `${clock(t)} · ${v == null ? (i < 0 ? "no data" : "offline") : `${v} ${info.unit}`}`;
      const px = ((vx / W) * r.width);
      tip.style.left = `${Math.min(r.width - 150, Math.max(0, px + 10))}px`;
    });
    svg.querySelector(".hit")!.addEventListener("mouseleave", () => { cross.style.display = "none"; tip.hidden = true; });
  }
  /** Name, current value, unit and limits of a trend key, from the live objects. */
  function trendInfo(key: string): { name: string; now: string; unit: string; limits: { lo: number | null; hi: number | null } } {
    const [id, prop] = key.split("|");
    for (const f of h.stations()) for (const r of readingsOf(f))
      if (r.twin_id === id && r.property === prop)
        return { name: `${f.name} · ${r.name ?? prop}`, now: r.offline ? "sensor offline" : `now ${r.value}`, unit: unitOf(r), limits: { lo: r.min, hi: r.max } };
    const g = h.gauges().find((x) => x.twin_id === id);
    if (g) return prop === "pressure_psi"
      ? { name: `${g.name} · water pressure`, now: g.psi != null ? `now ${g.psi} psi` : "no reading", unit: "psi", limits: { lo: 7, hi: null } }
      : { name: `${g.name} · chlorine residual`, now: g.chlorine != null ? `now ${g.chlorine} ppm` : "no reading", unit: "ppm", limits: { lo: 0.3, hi: 1.5 } };
    return { name: prop ?? "Reading", now: "", unit: "", limits: { lo: null, hi: null } };
  }

  function fpHead(p: AlarmPriority | null | undefined, title: string, state: string, sub: string): string {
    return `<div class="fp-head"><span class="fp-pill ${p ? `abn p${p}` : ""}">${p ? priShape(p, 14) : `<i class="dot"></i>`}${esc(state)}</span>` +
      `<div class="fp-t"><h2>${esc(title)}</h2>${sub ? `<div class="fp-sub">${sub}</div>` : ""}</div>` +
      `<div class="fp-tools"><button class="icobtn" data-act="fp-expand" title="${fpExpanded ? "Restore" : "Expand to the whole map area"}" aria-label="${fpExpanded ? "Restore" : "Expand"}">${fpExpanded ? ICON.shrink : ICON.expand}</button>` +
      `<button class="icobtn" data-act="fp-close" title="Close (Esc)" aria-label="Close faceplate">${ICON.close}</button></div></div>`;
  }
  const card = (icon: string, title: string, body: string, cls = "", extra = "") =>
    `<section class="card ${cls}"><header class="card-h">${icon}<span>${title}</span>${extra}</header>${body}</section>`;

  /** Draws the faceplate; with `keepTrend` (the trend card already on show), that card is moved into the new one as it is. */
  function renderFaceplate(keepTrend?: Element | null) {
    if (!fp) { face.hidden = true; return; }
    face.classList.toggle("expanded", fpExpanded);
    if (fp.kind === "station") {
      const f = h.stations().find((s) => s.uid === fp!.uid);
      if (!f) { fp = null; face.hidden = true; return; }
      const p = STATE_PRI[f.state ?? ""];
      const all = readingsOf(f);
      const rs = all.filter((r) => numOf(r) != null && keyOf(r) && !/^(yes|no)$/.test(r.value));
      if (!fp.trend && rs.length) fp.trend = keyOf(pick(rs, "level_pct", "storage") ?? pick(rs, "pressure_psi", "storage") ?? rs[0]);
      const state = f.standby && f.state === "ok" ? "Standby" : h.labels[f.state ?? ""] ?? "—";
      const sub = [f.barangay ? `${esc(f.barangay)}, Sorsogon City` : "", f.state !== "ok" && f.headline ? `<b>${esc(f.headline)}</b>` : "",
        f.affects ? `Affects ${esc(f.affects.split(", ").slice(0, 4).join(", "))}` : ""].filter(Boolean).join(" · ");
      // the readings, by equipment group; a numeric one opens its trend
      const groups = (f.groups || []).filter((g) => g.all.length).map((g) => {
        const gp = STATE_PRI[g.state];
        return `<div class="rg ${gp ? "abn" : ""}"><div class="rg-h"><span class="chip">${h.icon(`group:${g.group}`)}</span><b>${esc(g.title)}</b>${gp ? priShape(gp, 13) : ""}</div>` +
          `<div class="rg-list">` + g.all.map((r) => {
            const k = keyOf(r), trendable = rs.some((x) => keyOf(x) === k);
            const abn = r.alarm || r.offline;
            return `<button class="rd ${k === fp!.trend ? "on" : ""} ${abn ? "abn" : ""}" ${trendable ? `data-trend="${esc(k)}"` : "disabled"} title="${esc(r.alarm || r.name || "")}">` +
              `<span>${abn ? priShape(r.offline ? 3 : 2, 12) : ""}${esc(r.name ?? r.property)}</span><b>${esc(r.offline ? "COMM" : r.value)}</b></button>`;
          }).join("") + `</div></div>`;
      }).join("");
      face.innerHTML = fpHead(p, f.name, state, sub) + `<div class="fp-body">` +
        card(h.icon("station"), "Process", mimic(f), "fp-process") +
        card(ICON.grid, "Readings", `<div class="rgs">${groups || `<div class="muted">No live readings.</div>`}</div>`, "fp-readings", `<small>click one for its trend</small>`) +
        `<section class="card fp-trend"></section></div>`;
    } else {
      const g = h.gauges().find((x) => x.uid === fp!.uid);
      if (!g) { fp = null; face.hidden = true; return; }
      const p = STATE_PRI[g.state ?? ""] ?? null;
      const psi = g.type === "pressure_logger";
      if (!fp.trend && g.twin_id) fp.trend = `${g.twin_id}|${psi ? "pressure_psi" : "chlorine_residual_ppm"}`;
      const v = psi ? g.psi : g.chlorine;
      const reading = `<div class="fp-gauge"><div class="fg-v">${v != null && g.state !== "nodata" ? `${v}<small> ${psi ? "psi" : "ppm"}</small>` : `<span class="comm">${g.status === "offline" ? "COMM" : "—"}</span>`}</div>` +
        `<div class="fg-bar">` + (psi ? analogBar(v, 0, 60, 7, 60, p, 420) + `<div class="fg-scale"><span>0</span><span>normal: 7 psi and up</span><span>60 psi</span></div>`
          : analogBar(v, 0, 2, 0.3, 1.5, p, 420) + `<div class="fg-scale"><span>0</span><span>normal: 0.3 – 1.5 ppm</span><span>2 ppm</span></div>`) + `</div>` +
        `<div class="fg-txt">${esc(g.headline || "")}${g.action ? `<span>→ ${esc(g.action)}</span>` : ""}</div></div>`;
      face.innerHTML = fpHead(p, g.name, h.labels[g.state ?? ""] ?? "—", `${psi ? "Designated pressure point" : "Far-point chlorine check"}${g.affects ? ` · Affects ${esc(g.affects)}` : ""}`) +
        `<div class="fp-body">` + card(h.icon(psi ? "gauge-psi" : "gauge-cl"), psi ? "Water pressure" : "Chlorine residual", reading) +
        `<section class="card fp-trend"></section></div>`;
    }
    face.hidden = false;
    const nb = face.querySelector(".fp-trend");
    if (keepTrend && nb && keepTrend.childElementCount) { nb.replaceWith(keepTrend); return; }
    void renderTrend();
  }
  function openFaceplate(kind: "station" | "gauge", uid: string, trend = "") {
    fp = { kind, uid, trend, hours: fp?.hours ?? 8, table: false };
    renderFaceplate();
  }

  // ------------------------------------------------------------ events
  const showConsole = (f: typeof filter) => {
    const wasCollapsed = collapsed;
    collapsed = false; filter = f;
    renderConsole(); renderBar();
    if (wasCollapsed) h.onLayout();
  };
  const onBar = (e: MouseEvent) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-screen],[data-act],[data-pri]");
    if (!t) return;
    if (t.dataset.screen) {
      screen = t.dataset.screen as "map" | "grid";
      grid.hidden = screen !== "grid";
      renderBar(); renderGrid();
    } else if (t.dataset.pri) showConsole(filter === `p${t.dataset.pri}` ? "all" : (`p${t.dataset.pri}` as typeof filter));
    else if (t.dataset.act === "focus-alarms") showConsole(filter === "unack" ? "all" : "unack");
  };
  const onConsole = (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    const b = t.closest<HTMLElement>("[data-ack],[data-act],[data-filter]");
    if (b?.dataset.ack) { e.stopPropagation(); void ack([b.dataset.ack]); return; }
    if (b?.dataset.act === "ackall") { void ack("all"); return; }
    if (b?.dataset.act === "grip") return;
    if (b?.dataset.act === "collapse") { collapsed = !collapsed; renderConsole(); renderBar(); h.onLayout(); return; }
    if (b?.dataset.filter) { filter = b.dataset.filter as typeof filter; renderConsole(); renderBar(); return; }
    const row = t.closest<HTMLElement>("tr[data-id]");
    const a = row && alarms.find((x) => x.id === row.dataset.id);
    if (a) openSource(a);
  };
  const onGrid = (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest("[data-act=kpi]")) { gridAbnormal = true; renderGrid(); return; }
    const v = t.closest<HTMLElement>("td[data-trend]");
    const row = t.closest<HTMLElement>("tr[data-station]");
    if (row) {
      const uid = row.dataset.station!;
      h.openStation(uid);
      openFaceplate("station", uid, v?.dataset.trend || "");
      return;
    }
    const tile = t.closest<HTMLElement>("[data-gauge]");
    if (tile) { h.openGauge(tile.dataset.gauge!); openFaceplate("gauge", tile.dataset.gauge!); }
  };
  const onGridChange = (e: Event) => {
    const t = e.target as HTMLInputElement;
    if (t.dataset.act === "abn") { gridAbnormal = t.checked; renderGrid(); }
  };
  const onFace = (e: MouseEvent) => {
    const t = (e.target as Element).closest<HTMLElement | SVGElement>("[data-trend],[data-act],[data-hours]");
    if (!t || !fp) return;
    const ds = (t as HTMLElement).dataset;
    if (ds.act === "fp-close") { fp = null; face.hidden = true; return; }
    if (ds.act === "fp-expand") {
      fpExpanded = !fpExpanded;
      store.set("scada.fpExpanded", fpExpanded ? "1" : "0");
      face.classList.toggle("expanded", fpExpanded);
      const b = face.querySelector<HTMLElement>("[data-act=fp-expand]");
      if (b) { b.innerHTML = fpExpanded ? ICON.shrink : ICON.expand; b.title = fpExpanded ? "Restore" : "Expand to the whole map area"; }
      return;
    }
    if (ds.act === "table") { fp.table = !fp.table; void renderTrend(); return; }
    if (ds.hours) { fp.hours = Number(ds.hours); void renderTrend(); return; }
    if (ds.trend) {
      fp.trend = ds.trend;
      face.querySelectorAll<HTMLElement>(".rd[data-trend]").forEach((b) => b.classList.toggle("on", b.dataset.trend === ds.trend));
      void renderTrend();
      face.querySelector(".fp-trend")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && fp) { fp = null; face.hidden = true; } };
  bar.addEventListener("click", onBar);
  console_.addEventListener("click", onConsole);
  grid.addEventListener("click", onGrid);
  grid.addEventListener("change", onGridChange);
  face.addEventListener("click", onFace);
  document.addEventListener("keydown", onKey);
  console_.addEventListener("pointerdown", onGripDown);
  document.addEventListener("pointermove", onGripMove);
  document.addEventListener("pointerup", onGripUp);
  const clockTimer = setInterval(() => { const c = h.root.querySelector("#hp-clock"); if (c) c.textContent = clockLong(); }, 1000);
  // relative ages in the console ("12 min ago") move on
  const ageTimer = setInterval(() => { if (!collapsed && !drag) renderConsole(); }, 60_000);
  const trendTimer = setInterval(() => { if (fp && !document.hidden) { histCache.clear(); void renderTrend(); } }, 30_000);
  let trendSoon: ReturnType<typeof setTimeout> | null = null;

  renderBar();
  renderConsole();

  return {
    update() {
      renderBar();
      renderGrid();
      if (fp) {
        // keep the trend card itself (no flicker, and its buttons stay put under the pointer): redraw only the
        // schematic, the readings and the header
        renderFaceplate(face.querySelector(".fp-trend"));
        // then bring the trend up to date with the new reading (the server records it as it reads the twin), once
        // shortly after each update, so the line moves live while it is watched
        if (!trendSoon) trendSoon = setTimeout(() => {
          trendSoon = null;
          if (!fp || document.hidden) return;
          for (const k of [...histCache.keys()]) if (k.startsWith(`${fp.trend}|`)) histCache.delete(k);
          void renderTrend();
        }, 600);
      }
    },
    setAlarms(list) {
      alarms = list;
      received = true;
      renderBar();
      renderConsole();
      renderGrid();                       // the KPI strip counts alarms
    },
    openFaceplate,
    stop() {
      bar.removeEventListener("click", onBar);
      console_.removeEventListener("click", onConsole);
      grid.removeEventListener("click", onGrid);
      grid.removeEventListener("change", onGridChange);
      face.removeEventListener("click", onFace);
      document.removeEventListener("keydown", onKey);
      console_.removeEventListener("pointerdown", onGripDown);
      document.removeEventListener("pointermove", onGripMove);
      document.removeEventListener("pointerup", onGripUp);
      clearInterval(ageTimer);
      cancelAnimationFrame(raf);
      clearInterval(clockTimer);
      clearInterval(trendTimer);
      if (trendSoon) clearTimeout(trendSoon);
    },
  };
}

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
  let screen: "map" | "grid" = "map";
  let filter: "all" | "unack" | "p1" = "all";
  let collapsed = false;
  let gridAbnormal = false;
  let fp: { kind: "station" | "gauge"; uid: string; trend: string; hours: number; table: boolean } | null = null;

  // ------------------------------------------------------------ top bar: screens, alarm counts, clock
  function renderBar() {
    const act = alarms.filter((a) => !a.cleared);
    const unack = alarms.filter((a) => !a.acked).length;
    const by = (p: AlarmPriority) => act.filter((a) => a.priority === p).length;
    bar.innerHTML = `<div class="screens" role="tablist">` +
      ([["map", "Map"], ["grid", "Status grid"]] as const).map(([k, t]) =>
        `<button role="tab" aria-selected="${screen === k}" class="${screen === k ? "on" : ""}" data-screen="${k}">${t}</button>`).join("") + `</div>` +
      `<button class="alsum" data-act="focus-alarms" title="Active alarms by priority">` +
      ([1, 2, 3] as AlarmPriority[]).map((p) => `<span class="${by(p) ? "" : "zero"}">${priShape(p, 15)}<b>${by(p)}</b></span>`).join("") +
      `<span class="unack ${unack ? "on" : ""}">${unack} unacknowledged</span></button>` +
      `<span class="clock" id="hp-clock">${clock(Date.now())}</span>`;
  }

  // ------------------------------------------------------------ alarm console
  function renderConsole() {
    const unack = alarms.filter((a) => !a.acked).length;
    const rows = alarms.filter((a) => filter === "all" || (filter === "unack" ? !a.acked : a.priority === 1));
    const head = `<div class="ac-head"><button class="ac-toggle" data-act="collapse" aria-expanded="${!collapsed}">` +
      `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4"><path d="${collapsed ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"}"/></svg>ALARMS</button>` +
      `<span class="ac-count">${alarms.filter((a) => !a.cleared).length} active · ${unack} unacknowledged</span>` +
      `<div class="ac-filter" role="group" aria-label="Filter alarms">` +
      ([["all", "All"], ["unack", "Unacknowledged"], ["p1", "Priority 1"]] as const).map(([k, t]) =>
        `<button class="${filter === k ? "on" : ""}" data-filter="${k}">${t}</button>`).join("") + `</div>` +
      `<button class="ac-ackall" data-act="ackall" ${unack ? "" : "disabled"}>Acknowledge all</button></div>`;
    if (collapsed) { console_.innerHTML = head; console_.classList.add("collapsed"); return; }
    console_.classList.remove("collapsed");
    const body = rows.length ? `<table class="ac-table"><thead><tr><th>Pri</th><th>Raised</th><th>Source</th><th>Alarm</th><th>State</th><th></th></tr></thead><tbody>` +
      rows.map((a) => {
        const st = a.cleared ? (a.acked ? "Cleared" : "Returned to normal") : a.acked ? "Acknowledged" : "Unacknowledged";
        return `<tr class="${a.acked ? "acked" : "unacked"} ${a.cleared ? "rtn" : ""} p${a.priority}" data-id="${esc(a.id)}">` +
          `<td>${priShape(a.priority)}</td><td class="tm">${esc(clock(a.raised))}</td><td class="src">${esc(a.name)}</td>` +
          `<td class="msg">${esc(a.text)}</td><td class="st">${st}${a.cleared ? ` · ${esc(clock(a.cleared))}` : ""}</td>` +
          `<td>${a.acked ? "" : `<button class="ack" data-ack="${esc(a.id)}">Ack</button>`}</td></tr>`;
      }).join("") + `</tbody></table>`
      : `<div class="ac-empty">${alarms.length ? "No alarms match this filter." : "No alarms. Every station and gauge is normal."}</div>`;
    console_.innerHTML = head + `<div class="ac-body">${body}</div>`;
  }
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
    return `<td class="state ${p ? "abn" : ""}">${p ? priShape(p, 13) : ""}${esc(standby && st === "ok" ? "Standby" : h.labels[st ?? ""] ?? "—")}</td>`;
  }
  function renderGrid() {
    if (screen !== "grid") return;
    const ss = h.stations().filter((f) => f.twin_id).sort((a, b) => a.name.localeCompare(b.name));
    const shown = gridAbnormal ? ss.filter((f) => f.state && f.state !== "ok") : ss;
    const gs = h.gauges().filter((g) => g.twin_id);
    const dpps = gs.filter((g) => g.type === "pressure_logger").filter((g) => !gridAbnormal || (g.state && g.state !== "ok")).sort((a, b) => a.name.localeCompare(b.name));
    const chl = gs.filter((g) => g.type === "chlorine_point").filter((g) => !gridAbnormal || (g.state && g.state !== "ok")).sort((a, b) => a.name.localeCompare(b.name));
    let html = `<div class="g-tools"><label><input type="checkbox" data-act="abn" ${gridAbnormal ? "checked" : ""}> Abnormal only</label>` +
      `<span class="g-note">Grey is normal. A shape and number mark anything abnormal (1 high, 2 medium, 3 low). Click a row for its faceplate, a value for its trend.</span></div>`;
    html += `<h3>Pumping stations and bulk supply <span>${shown.length}</span></h3><div class="g-scroll"><table class="g-table"><thead><tr>` +
      `<th>Station</th><th>State</th><th>Pump</th><th>VFD Hz</th><th>Tank %</th><th></th><th>Outlet psi</th><th>Outlet L/s</th><th>Cl₂ ppm</th><th>Power</th><th>Gen fuel %</th><th>Alarms</th></tr></thead><tbody>` +
      shown.map((f) => {
        const rs = readingsOf(f);
        const speed = pick(rs, "speed_hz", "vfd"), run = pick(rs, "run_status");
        const running = run ? /run|on/i.test(run.value) : (numOf(speed) ?? 0) > 0;
        const pump = !speed && !run ? `<td class="na">—</td>` : `<td class="${f.groups.find((g) => g.group === "pumping")?.state === "down" ? "abn" : ""}">${running ? "Running" : f.standby ? "Standby" : "Stopped"}</td>`;
        const tank = pick(rs, "level_pct", "storage");
        const tankN = numOf(tank);
        const flow = pick(rs, "flow_lps", "storage") ?? pick(rs, "flow_lps");
        const n = (f.issues || []).length;
        return `<tr data-station="${esc(f.uid)}"><th>${esc(f.name)}</th>${stateCell(f.state, f.standby)}${pump}${cell(speed, 0)}${cell(tank, 0)}` +
          `<td class="bar">${tank && !tank.offline ? analogBar(tankN, 0, 100, 25, 100, tank.alarm ? 2 : null, 90) : ""}</td>` +
          `${cell(pick(rs, "pressure_psi", "storage") ?? pick(rs, "pressure_psi"))}${cell(flow)}${cell(pick(rs, "chlorine_residual_ppm"), 2)}` +
          `${cell(pick(rs, "power_source"))}${cell(pick(rs, "fuel_level_pct"), 0)}<td class="${n ? "abn" : "na"}">${n || "—"}</td></tr>`;
      }).join("") + `</tbody></table></div>`;
    const tile = (g: Gauge, kind: "psi" | "ppm") => {
      const v = kind === "psi" ? g.psi : g.chlorine;
      const p = STATE_PRI[g.state ?? ""] ?? null;
      const bar = kind === "psi" ? analogBar(v, 0, 60, 7, 60, p, 150) : analogBar(v, 0, 2, 0.3, 1.5, p, 150);
      return `<button class="g-tile ${p ? "abn" : ""}" data-gauge="${esc(g.uid)}" title="${esc(g.headline || "")}">` +
        `<span class="gt-n">${p ? priShape(p, 13) : ""}${esc(g.name)}</span>` +
        `<span class="gt-v">${v != null && g.state !== "nodata" ? `${v}<small> ${kind}</small>` : `<span class="comm">${g.status === "offline" ? "COMM" : "—"}</span>`}</span>${bar}</button>`;
    };
    html += `<h3>Designated pressure points <span>${dpps.length}</span><em>normal range 7 psi and up</em></h3><div class="g-tiles">${dpps.map((g) => tile(g, "psi")).join("")}</div>`;
    if (chl.length) html += `<h3>Far-point chlorine <span>${chl.length}</span><em>normal range 0.3 – 1.5 ppm</em></h3><div class="g-tiles">${chl.map((g) => tile(g, "ppm")).join("")}</div>`;
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
    const run = pick(rs, "run_status");
    const running = run ? /run|on/i.test(run.value) : (numOf(speed) ?? 0) > 0;
    const flowing = running || (numOf(pick(rs, "flow_lps", "storage")) ?? 0) > 0;
    const bulk = f.kind === "bulk";
    const tankR = pick(rs, "level_pct", "storage");
    const level = numOf(tankR);
    const pipe = (d: string, on = flowing) => `<path class="pipe ${on ? "on" : ""}" d="${d}"/>`;
    let s = `<svg class="pid" viewBox="0 0 1000 390" text-anchor="middle" role="img" aria-label="Process schematic of ${esc(f.name)}">`;
    s += `<line class="ground" x1="20" y1="112" x2="980" y2="112"/>`;
    // ---- source: a well with its submersible pump, or a bulk supply point
    if (bulk) {
      s += `<rect class="equip" x="30" y="122" width="110" height="56" rx="3"/><text class="lbl" x="85" y="146">BULK SUPPLY</text>` +
        `<text class="sub" x="85" y="164">${esc(f.name)}</text>` + flag(118, 104, G.get("source"));
      s += instrument(205, 150, "FT", pick(rs, "flow_lps", "source"), 1, false) + instrument(275, 150, "AIT", pick(rs, "chlorine_residual_ppm", "source"), 2, false);
      s += pipe("M140 150 H 520");
    } else {
      s += `<path class="casing" d="M68 112 V 330 M112 112 V 330"/><text class="lbl" x="90" y="352">WELL</text>` + flag(118, 300, G.get("source"));
      s += `<g class="hot" ${run ? `data-trend="${esc(keyOf(run))}"` : ""}><title>Submersible pump: ${running ? "running" : "stopped"}</title>` +
        `<circle class="pump ${running ? "on" : ""}" cx="90" cy="285" r="19"/><path class="pump-tri ${running ? "on" : ""}" d="M90 270 L104 292 H76 Z"/></g>` +
        `<text class="lbl" x="122" y="322" text-anchor="start">PUMP</text><text class="sub" x="122" y="337" text-anchor="start">${running ? "Running" : f.standby ? "Standby" : "Stopped"}</text>` +
        flag(118, 252, G.get("pumping"));
      s += pipe("M90 266 V 150 H 520");
      // the pump drive, wired to the pump
      if (speed || current || fault) {
        s += `<line class="elec" x1="109" y1="285" x2="200" y2="285"/>` +
          `<rect class="equip" x="200" y="252" width="130" height="62" rx="3"/><text class="lbl" x="265" y="269">VFD</text>` +
          `<g class="hot" ${speed ? `data-trend="${esc(keyOf(speed))}"` : ""}><text class="val" x="232" y="290">${speed ? (speed.offline ? "COMM" : `${numOf(speed) ?? "—"} Hz`) : ""}</text></g>` +
          `<g class="hot" ${current ? `data-trend="${esc(keyOf(current))}"` : ""}><text class="val" x="297" y="290">${current ? (current.offline ? "COMM" : `${numOf(current) ?? "—"} A`) : ""}</text></g>` +
          `<text class="sub ${fault && !/none|ok|^0$/i.test(fault.value) ? "abn-t" : ""}" x="265" y="307">${fault ? `fault: ${esc(fault.value)}` : ""}</text>` + flag(322, 244, G.get("vfd"));
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
        `<line class="dose ${dosing ? "on" : ""}" x1="389" y1="47" x2="430" y2="47"/>` +
        `<g class="hot" ${dose ? `data-trend="${esc(keyOf(dose))}"` : ""}><title>Chlorine dosing pump</title><circle class="pump ${dosing ? "on" : ""}" cx="445" cy="47" r="13"/></g>` +
        `<text class="val sm" x="445" y="25">${dose ? (dose.offline ? "COMM" : `${numOf(dose)} L/h`) : ""}</text>` +
        `<path class="dose ${dosing ? "on" : ""}" d="M445 60 V 150"/><circle class="inj" cx="445" cy="150" r="4"/>` + flag(468, 22, G.get("treatment"));
    }
    // ---- storage: inlet valve, tank with level, outlet valve
    s += valve(530, 150, pick(rs, "valve_position_pct_open", "storage", "inlet"), "INLET");
    s += pipe("M543 150 H 600");
    s += `<g class="hot ${tankR?.alarm ? "abn" : ""}" ${tankR ? `data-trend="${esc(keyOf(tankR))}"` : ""}><title>Storage tank${level != null ? `: ${level}%` : ""}</title>` +
      `<rect class="equip tank" x="600" y="60" width="150" height="220" rx="6"/>` +
      (level != null && !tankR?.offline ? `<rect class="fill" x="603" y="${63 + 214 * (1 - Math.min(100, level) / 100)}" width="144" height="${214 * Math.min(100, level) / 100}" rx="3"/>` : "") +
      `<text class="lbl" x="675" y="52">STORAGE TANK</text>` +
      `<rect class="vbox" x="635" y="150" width="80" height="26" rx="2"/><text class="val big" x="675" y="169">${tankR ? (tankR.offline ? "COMM" : `${level ?? "—"} %`) : "—"}</text>` +
      `</g>` + flag(756, 52, G.get("storage"));
    // the outlet: valve, then pressure, flow and chlorine, values alternating below / above the line
    s += pipe("M750 250 H 778");
    s += valve(791, 250, pick(rs, "valve_position_pct_open", "storage", "outlet"), "OUTLET");
    s += pipe("M804 250 H 975");
    s += instrument(855, 250, "PT", pick(rs, "pressure_psi", "storage"), 1, true) + instrument(908, 250, "FT", pick(rs, "flow_lps", "storage"), 1, false) +
      instrument(958, 250, "AIT", pick(rs, "chlorine_residual_ppm", "storage"), 2, true);
    s += `<path class="arrow ${flowing ? "on" : ""}" d="M975 240 L992 250 L975 260 Z"/><text class="lbl" x="992" y="330" text-anchor="end">TO NETWORK</text>` +
      (f.affects ? `<text class="sub" x="992" y="346" text-anchor="end">${esc(f.affects.split(", ").slice(0, 3).join(", "))}</text>` : "");
    // ---- power: grid, generator, transfer switch, to the drive
    const present = pick(rs, "power_present"), source = pick(rs, "power_source"), fuel = pick(rs, "fuel_level_pct"), volts = pick(rs, "supply_voltage_v");
    // ---- power, one row under the drive: transfer switch (ATS) <- grid, <- generator; the ATS feeds the drive
    if (present || source || fuel) {
      const onGen = /gen/i.test(source?.value ?? "");
      const Y = 336, Hh = 42;
      s += `<rect class="equip" x="215" y="${Y}" width="100" height="${Hh}" rx="3"/><text class="lbl" x="265" y="${Y + 16}">ATS</text>` +
        `<text class="sub" x="265" y="${Y + 33}">on ${esc(source?.value ?? "—")}</text>`;
      if (!bulk && (speed || current || fault)) s += `<line class="elec on" x1="265" y1="314" x2="265" y2="${Y}"/>`;
      s += `<line class="elec ${onGen ? "" : "on"}" x1="315" y1="${Y + 21}" x2="355" y2="${Y + 21}"/>` +
        `<rect class="equip ${present?.value === "no" ? "abn-box" : ""}" x="355" y="${Y}" width="120" height="${Hh}" rx="3"/><text class="lbl" x="415" y="${Y + 16}">GRID</text>` +
        `<g class="hot" ${volts ? `data-trend="${esc(keyOf(volts))}"` : ""}><text class="val sm" x="415" y="${Y + 33}">${present ? (present.value === "yes" ? "Power on" : "POWER OFF") : ""}${volts && !volts.offline ? ` · ${numOf(volts)} V` : ""}</text></g>` +
        flag(467, Y - 9, G.get("grid"));
      s += `<path class="elec ${onGen ? "on" : ""}" d="M560 ${Y + Hh} V ${Y + Hh + 8} H 290 V ${Y + Hh}"/>` +
        `<rect class="equip" x="500" y="${Y}" width="120" height="${Hh}" rx="3"/><text class="lbl" x="560" y="${Y + 16}">GENERATOR</text>` +
        `<g class="hot ${fuel?.alarm ? "abn" : ""}" ${fuel ? `data-trend="${esc(keyOf(fuel))}"` : ""}><text class="val sm" x="560" y="${Y + 33}">${fuel ? (fuel.offline ? "COMM" : `fuel ${numOf(fuel)}%`) : ""}</text></g>` +
        flag(612, Y - 9, G.get("generator"));
    }
    s += `</svg>`;
    return s + `<div class="pid-key"><span><i class="k-on"></i>Running / open</span><span><i class="k-off"></i>Stopped / closed</span>` +
      `<span>${priShape(1, 13)}${priShape(2, 13)}${priShape(3, 13)} Alarm priority</span><span>Click an instrument for its trend</span></div>`;
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
    const W = 860, H = 230, L = 46, R = 14, T = 14, B = 26;
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
    // the line, broken where the sensor was offline; each value held until the next sample (a step)
    let path = "", pen = false;
    for (let i = 0; i < d.t.length; i++) {
      const v = d.v[i], t = Math.max(d.t[i]!, t0);
      if (v == null) { pen = false; continue; }
      if (!pen) { path += `M${x(t).toFixed(1)} ${y(v).toFixed(1)}`; pen = true; }
      else path += `H${x(t).toFixed(1)}V${y(v).toFixed(1)}`;
      if (i === d.t.length - 1) path += `H${x(now).toFixed(1)}`;
    }
    s += `<path class="line" d="${path}"/>`;
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
    const head = `<div class="tr-head"><b>${esc(info.name)}</b><span>${esc(info.now)}</span><div class="ranges" role="group" aria-label="Time range">` +
      ([[1, "1 h"], [8, "8 h"], [24, "24 h"], [168, "7 d"]] as const).map(([hh, t]) => `<button class="${hours === hh ? "on" : ""}" data-hours="${hh}">${t}</button>`).join("") +
      `</div><button class="linkish" data-act="table">${fp.table ? "Chart" : "Table"}</button></div>`;
    if (!d || !d.t.length || d.v.every((v) => v == null)) {
      box.innerHTML = head + `<div class="tr-empty">${d ? "No samples in this time range yet. The server records every reading while the monitor is open (every few seconds, kept 7 days), so the trend fills in from now on." : "The history could not be loaded."}</div>`;
      return;
    }
    if (fp.table) {
      const rows = d.t.map((t, i) => [t, d.v[i]] as const).filter(([t]) => t >= Date.now() - hours * 3.6e6).reverse().slice(0, 200);
      box.innerHTML = head + `<div class="tr-table"><table><thead><tr><th>Time</th><th>Value</th></tr></thead><tbody>` +
        rows.map(([t, v]) => `<tr><td>${esc(clock(t))}</td><td>${v == null ? "offline" : `${v} ${esc(info.unit)}`}</td></tr>`).join("") + `</tbody></table></div>`;
      return;
    }
    const chart = trendSvg(d, hours, info.limits, info.unit);
    box.innerHTML = head + `<div class="tr-plot">${chart.svg}<div class="tip" hidden></div></div>`;
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

  function renderFaceplate() {
    if (!fp) { face.hidden = true; return; }
    const close = `<button class="fp-close" data-act="fp-close" aria-label="Close faceplate">×</button>`;
    if (fp.kind === "station") {
      const f = h.stations().find((s) => s.uid === fp!.uid);
      if (!f) { fp = null; face.hidden = true; return; }
      const p = STATE_PRI[f.state ?? ""];
      const rs = readingsOf(f).filter((r) => numOf(r) != null && keyOf(r) && !/^(yes|no)$/.test(r.value));
      if (!fp.trend && rs.length) fp.trend = keyOf(pick(rs, "level_pct", "storage") ?? pick(rs, "pressure_psi", "storage") ?? rs[0]);
      face.innerHTML = `<div class="fp-head">${p ? priShape(p, 20) : ""}<div><h2>${esc(f.name)}</h2>` +
        `<div class="fp-state ${p ? "abn" : ""}">${esc(f.standby && f.state === "ok" ? "Standby" : f.headline || h.labels[f.state ?? ""] || "")}</div></div>${close}</div>` +
        `<div class="fp-body">${mimic(f)}` +
        `<div class="fp-chips" role="group" aria-label="Readings to trend">` + rs.map((r) => {
          const k = keyOf(r);
          return `<button class="${k === fp!.trend ? "on" : ""} ${r.alarm || r.offline ? "abn" : ""}" data-trend="${esc(k)}">${esc(r.name ?? r.property)}<b>${esc(r.offline ? "COMM" : r.value)}</b></button>`;
        }).join("") + `</div><div class="fp-trend"></div></div>`;
    } else {
      const g = h.gauges().find((x) => x.uid === fp!.uid);
      if (!g) { fp = null; face.hidden = true; return; }
      const p = STATE_PRI[g.state ?? ""] ?? null;
      const psi = g.type === "pressure_logger";
      if (!fp.trend && g.twin_id) fp.trend = `${g.twin_id}|${psi ? "pressure_psi" : "chlorine_residual_ppm"}`;
      const v = psi ? g.psi : g.chlorine;
      face.innerHTML = `<div class="fp-head">${p ? priShape(p, 20) : ""}<div><h2>${esc(g.name)}</h2>` +
        `<div class="fp-state ${p ? "abn" : ""}">${esc(g.headline || "")}</div></div>${close}</div>` +
        `<div class="fp-body"><div class="fp-gauge"><div class="fg-v">${v != null && g.state !== "nodata" ? `${v}<small> ${psi ? "psi" : "ppm"}</small>` : `<span class="comm">${g.status === "offline" ? "COMM" : "—"}</span>`}</div>` +
        (psi ? analogBar(v, 0, 60, 7, 60, p, 360) + `<div class="fg-scale"><span>0</span><span>normal: 7 psi and up</span><span>60 psi</span></div>`
          : analogBar(v, 0, 2, 0.3, 1.5, p, 360) + `<div class="fg-scale"><span>0</span><span>normal: 0.3 – 1.5 ppm</span><span>2 ppm</span></div>`) +
        `</div><div class="fp-trend"></div></div>`;
    }
    face.hidden = false;
    void renderTrend();
  }
  function openFaceplate(kind: "station" | "gauge", uid: string, trend = "") {
    fp = { kind, uid, trend, hours: fp?.hours ?? 8, table: false };
    renderFaceplate();
  }

  // ------------------------------------------------------------ events
  const onBar = (e: MouseEvent) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-screen],[data-act]");
    if (!t) return;
    if (t.dataset.screen) {
      screen = t.dataset.screen as "map" | "grid";
      grid.hidden = screen !== "grid";
      renderBar(); renderGrid();
    } else if (t.dataset.act === "focus-alarms") {
      collapsed = false; filter = "unack"; renderConsole(); h.onLayout();
    }
  };
  const onConsole = (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    const b = t.closest<HTMLElement>("[data-ack],[data-act],[data-filter]");
    if (b?.dataset.ack) { e.stopPropagation(); void ack([b.dataset.ack]); return; }
    if (b?.dataset.act === "ackall") { void ack("all"); return; }
    if (b?.dataset.act === "collapse") { collapsed = !collapsed; renderConsole(); h.onLayout(); return; }
    if (b?.dataset.filter) { filter = b.dataset.filter as typeof filter; renderConsole(); return; }
    const row = t.closest<HTMLElement>("tr[data-id]");
    const a = row && alarms.find((x) => x.id === row.dataset.id);
    if (a) openSource(a);
  };
  const onGrid = (e: MouseEvent) => {
    const t = e.target as HTMLElement;
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
    if (ds.act === "table") { fp.table = !fp.table; void renderTrend(); return; }
    if (ds.hours) { fp.hours = Number(ds.hours); void renderTrend(); return; }
    if (ds.trend) {
      fp.trend = ds.trend;
      face.querySelectorAll<HTMLElement>(".fp-chips button").forEach((b) => b.classList.toggle("on", b.dataset.trend === ds.trend));
      void renderTrend();
    }
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && fp) { fp = null; face.hidden = true; } };
  bar.addEventListener("click", onBar);
  console_.addEventListener("click", onConsole);
  grid.addEventListener("click", onGrid);
  grid.addEventListener("change", onGridChange);
  face.addEventListener("click", onFace);
  document.addEventListener("keydown", onKey);
  const clockTimer = setInterval(() => { const c = h.root.querySelector("#hp-clock"); if (c) c.textContent = clock(Date.now()); }, 1000);
  const trendTimer = setInterval(() => { if (fp && !document.hidden) { histCache.clear(); void renderTrend(); } }, 30_000);

  renderBar();
  renderConsole();

  return {
    update() {
      renderGrid();
      if (fp) {
        // keep the trend chart as it is (no flicker): redraw only the schematic and the header
        const trendBox = face.querySelector(".fp-trend");
        const keep = trendBox?.innerHTML;
        renderFaceplate();
        const nb = face.querySelector(".fp-trend");
        if (nb && keep) nb.innerHTML = keep;
      }
    },
    setAlarms(list) {
      alarms = list;
      renderBar();
      renderConsole();
    },
    openFaceplate,
    stop() {
      bar.removeEventListener("click", onBar);
      console_.removeEventListener("click", onConsole);
      grid.removeEventListener("click", onGrid);
      grid.removeEventListener("change", onGridChange);
      face.removeEventListener("click", onFace);
      document.removeEventListener("keydown", onKey);
      clearInterval(clockTimer);
      clearInterval(trendTimer);
    },
  };
}

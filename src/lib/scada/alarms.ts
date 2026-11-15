import "server-only";
import type { StatusGis } from "@/lib/status/compute";
import type { LiveResponse } from "@/lib/status/types";
import type { Alarm, AlarmKind, AlarmPriority } from "./types";

// The alarm list of the SCADA console, kept on the server so every operator sees the same list and the same
// acknowledgements (ISA-18.2 states): an alarm is raised when a problem first shows up, stays "unacknowledged" until
// an operator acknowledges it, and when the problem clears it "returns to normal": an acknowledged alarm then leaves
// the list, an unacknowledged one stays (RTN) until acknowledged, so a short problem is never missed.
// Kept in memory: a server restart starts a new list (the problems still there are raised again).

/** down: high (1), attention: medium (2), no data: low (3). */
const PRIORITY: Record<string, AlarmPriority> = { down: 1, attention: 2, nodata: 3 };
/** returned-to-normal alarms kept at most (the oldest go first) */
const MAX_RTN = 300;

interface Store { alarms: Map<string, Alarm>; listeners: Set<(list: Alarm[]) => void>; version: number }
// on globalThis so dev hot reloads keep one list
const g = globalThis as { __scadaAlarms?: Store };
const st: Store = (g.__scadaAlarms ??= { alarms: new Map(), listeners: new Set(), version: 0 });

/** "Tank level low (22%)" -> "Tank level low": the condition, so a changing value is the same alarm. */
export const condition = (text: string) => text.replace(/\s*\([^)]*\)\s*$/, "").trim();

interface Raised { id: string; source: string; kind: AlarmKind; name: string; text: string; group: string | null; priority: AlarmPriority; since: string | null }

/** The problems in a status, one per (source, condition). */
export function activeProblems(body: LiveResponse, gis: StatusGis): Raised[] {
  const out: Raised[] = [];
  const M = body.monitor;
  const stationName = new Map(gis.facilities.map((f) => [f.twin_id, f.name]));
  const gaugeName = new Map(gis.meters.features.map((f) => [f.properties.twin_id, f.properties.name]));
  for (const [id, s] of Object.entries(M.stations))
    for (const a of s.alarms ?? []) {
      const p = PRIORITY[a.state];
      if (!p) continue;
      out.push({ id: `${id}|${condition(a.text)}`, source: id, kind: "station", name: stationName.get(id) ?? id, text: a.text,
        group: a.group, priority: p, since: s.since });
    }
  for (const [id, gs] of Object.entries(M.gauges)) {
    const p = PRIORITY[gs.state];
    if (!p) continue;
    out.push({ id: `${id}|${condition(gs.headline)}`, source: id, kind: "gauge", name: gaugeName.get(id) ?? id, text: gs.headline,
      group: null, priority: p, since: null });
  }
  for (const [id, pp] of Object.entries(M.pipes)) {
    if (!pp.alarm) continue;
    const where = id.replace("-distribution", "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    out.push({ id: `${id}|${condition(pp.alarm)}`, source: id, kind: "pipe", name: `Pipes in ${where}`, text: pp.alarm,
      group: null, priority: 2, since: null });
  }
  return out;
}

const emit = () => {
  st.version++;
  const list = alarmList();
  for (const l of st.listeners) l(list);
};

/** Brings the list up to date with a new status (lib/status/live.ts calls it on every new reading of the twin). */
export function syncAlarms(body: LiveResponse, gis: StatusGis, at: string): void {
  const first = st.alarms.size === 0 && st.version === 0;
  const now = new Map(activeProblems(body, gis).map((r) => [r.id, r]));
  let changed = false;
  for (const [id, a] of st.alarms) {
    if (now.has(id) || a.cleared) continue;
    changed = true;
    if (a.acked) st.alarms.delete(id);                  // acknowledged and over: off the list
    else a.cleared = at;                                // over but never acknowledged: stays as RTN
  }
  for (const r of now.values()) {
    const a = st.alarms.get(r.id);
    if (!a) {
      // on the server's first look, a station's problem dates from when its state began (if known)
      st.alarms.set(r.id, { id: r.id, source: r.source, kind: r.kind, name: r.name, text: r.text, group: r.group,
        priority: r.priority, raised: (first && r.since) || at, cleared: null, acked: null });
      changed = true;
    } else if (a.cleared) {                               // back again: a new alarm
      Object.assign(a, { text: r.text, priority: r.priority, raised: at, cleared: null, acked: null });
      changed = true;
    } else if (a.text !== r.text || a.priority !== r.priority) {
      if (r.priority < a.priority) a.acked = null;        // worse than when acknowledged: needs a new acknowledgement
      Object.assign(a, { text: r.text, priority: r.priority });
      changed = true;
    }
  }
  const rtn = [...st.alarms.values()].filter((a) => a.cleared).sort((x, y) => x.cleared!.localeCompare(y.cleared!));
  for (const a of rtn.slice(0, Math.max(0, rtn.length - MAX_RTN))) st.alarms.delete(a.id);
  if (changed || first) emit();
}

/** Acknowledges some alarms (or all of them); returns how many were acknowledged. */
export function acknowledge(ids: string[] | "all", at = new Date().toISOString()): number {
  let n = 0;
  for (const a of [...st.alarms.values()]) {
    if (a.acked || (ids !== "all" && !ids.includes(a.id))) continue;
    n++;
    if (a.cleared) st.alarms.delete(a.id);              // over and now seen: off the list
    else a.acked = at;
  }
  if (n) emit();
  return n;
}

/** Unacknowledged active, unacknowledged returned to normal, then acknowledged; each by priority, newest first. */
export function alarmList(): Alarm[] {
  const rank = (a: Alarm) => (a.acked ? 2 : a.cleared ? 1 : 0);
  return [...st.alarms.values()].sort((a, b) => rank(a) - rank(b) || a.priority - b.priority || b.raised.localeCompare(a.raised));
}

/** Calls `l` with the list now (once there is one: before the first look at the twin an empty list would say "no
 * alarms" untruly) and on every change. */
export function watchAlarms(l: (list: Alarm[]) => void): () => void {
  st.listeners.add(l);
  if (st.version > 0) l(alarmList());
  return () => { st.listeners.delete(l); };
}

/** For tests: an empty list. */
export function resetAlarms(): void {
  st.alarms.clear();
  st.version = 0;
}

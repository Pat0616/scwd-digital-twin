import "server-only";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { LiveResponse } from "@/lib/status/types";
import type { History } from "./types";

// The trends' data: every numeric reading of the twin, sampled each time the server reads the twin (every few
// seconds while someone watches). The twin keeps only the latest value, so the history is built here. A value
// that has not changed is stored again once a minute at most, so a steady reading still draws a line; an offline
// sensor is stored as a gap. Kept 7 days, saved to .scada/history.json (SCADA_DATA_DIR) once a minute.

const KEEP_MS = 7 * 24 * 3.6e6;
const SAME_VALUE_MS = 60_000;
const SAVE_MS = 60_000;
const DIR = process.env.SCADA_DATA_DIR || path.join(process.cwd(), ".scada");
const FILE = path.join(DIR, "history.json");

interface Series { t: number[]; v: (number | null)[] }
interface Store { series: Map<string, Series>; loaded: boolean; dirty: boolean; timer: ReturnType<typeof setTimeout> | null }
const g = globalThis as { __scadaHistory?: Store };
const st: Store = (g.__scadaHistory ??= { series: new Map(), loaded: false, dirty: false, timer: null });

/** A reading's key: `${twin id}|${property}`, e.g. "pumpstation-01-storage|level_pct". */
export const historyKey = (twinId: string, property: string) => `${twinId}|${property}`;

function load() {
  if (st.loaded) return;
  st.loaded = true;
  try {
    const data = JSON.parse(readFileSync(FILE, "utf8")) as Record<string, Series>;
    for (const [k, s] of Object.entries(data)) if (Array.isArray(s.t) && Array.isArray(s.v)) st.series.set(k, s);
  } catch { /* no history yet */ }
}

function save() {
  st.timer = null;
  if (!st.dirty) return;
  st.dirty = false;
  try {
    mkdirSync(DIR, { recursive: true });
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(st.series)));
    renameSync(tmp, FILE);
  } catch (err) {
    console.error("scada history: could not save", err);
  }
}

function add(key: string, at: number, value: number | null) {
  let s = st.series.get(key);
  if (!s) st.series.set(key, (s = { t: [], v: [] }));
  const n = s.t.length;
  if (n && at <= s.t[n - 1]!) return;
  if (n && s.v[n - 1] === value && at - s.t[n - 1]! < SAME_VALUE_MS) return;
  s.t.push(at);
  s.v.push(value);
  let drop = 0;
  while (drop < s.t.length && s.t[drop]! < at - KEEP_MS) drop++;
  if (drop) { s.t.splice(0, drop); s.v.splice(0, drop); }
  st.dirty = true;
}

/** Stores the numeric readings of a status, as of `at` (when the twin was read). */
export function recordHistory(body: LiveResponse, at: string): void {
  load();
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) return;
  for (const s of Object.values(body.stations))
    for (const grp of s.sensors)
      for (const r of grp.items)
        if (r.twin_id && r.property && (r.number != null || !r.online)) add(historyKey(r.twin_id, r.property), ms, r.online ? r.number : null);
  for (const [id, gs] of Object.entries(body.gauges)) {
    const prop = gs.kind === "pressure" ? "pressure_psi" : gs.kind === "chlorine" ? "chlorine_residual_ppm" : null;
    if (prop) add(historyKey(id, prop), ms, gs.online ? gs.value : null);
  }
  if (st.dirty && !st.timer) {
    st.timer = setTimeout(save, SAVE_MS);
    st.timer.unref?.();
  }
}

/** A reading's samples from `since` (ms) on, plus the last one before it (so the line starts at the left edge). */
export function getHistory(key: string, since: number): History {
  load();
  const s = st.series.get(key);
  if (!s) return { key, t: [], v: [] };
  let i = s.t.findIndex((t) => t >= since);
  if (i < 0) i = s.t.length;
  const from = Math.max(0, i - 1);
  return { key, t: s.t.slice(from), v: s.v.slice(from) };
}

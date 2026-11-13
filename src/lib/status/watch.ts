import "server-only";
import { liveStatus, type LiveStatus } from "./live";

/** How often the twin is checked while at least one browser is watching. */
export const WATCH_MS = 3_000;

export type WatchEvent =
  | { type: "status"; status: LiveStatus }
  | { type: "checked"; fetchedAt: string }
  | { type: "error" };

type Listener = (e: WatchEvent) => void;

interface WatchState { listeners: Set<Listener>; running: boolean; last: LiveStatus | null }

// on globalThis so dev hot reloads share one loop instead of starting another
const g = globalThis as { __twinWatch?: WatchState };
const st: WatchState = (g.__twinWatch ??= { listeners: new Set(), running: false, last: null });

const emit = (e: WatchEvent) => { for (const l of st.listeners) l(e); };

/** One loop for every watcher: reads the twin every WATCH_MS and sends the status when the graph changed. */
async function tick() {
  try {
    const live = await liveStatus();
    if (live.version !== st.last?.version) { st.last = live; emit({ type: "status", status: live }); }
    emit({ type: "checked", fetchedAt: live.fetchedAt });
  } catch (err) {
    // the details stay in the server log: no credentials or twin data to the browser
    console.error("twin watch:", err);
    emit({ type: "error" });
  } finally {
    if (st.listeners.size) setTimeout(tick, WATCH_MS);
    else st.running = false;
  }
}

/** Calls `l` with the current status, then on every change; the loop stops when the last watcher leaves. */
export function watchStatus(l: Listener): () => void {
  st.listeners.add(l);
  if (st.last) l({ type: "status", status: st.last });
  if (!st.running) { st.running = true; void tick(); }
  return () => { st.listeners.delete(l); };
}

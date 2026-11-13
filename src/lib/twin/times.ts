import type { Twin } from "./types";

const TIME_KEYS = ["readings_at", "last_seen"] as const;

const timeOf = (t: Twin, k: string) => (typeof t[k] === "string" ? Date.parse(t[k] as string) : NaN);

/**
 * Moves an old snapshot's reading times so its newest reading is `now` (as twin_sync._shift_times), while readings
 * that are already current stay as they are. The live instance mixes the two: a snapshot loaded days ago and parts
 * updated since (e.g. a pump stopped a minute ago). Anchoring on the newest reading overall would leave the snapshot
 * stale; so only times older than `staleHours` move, and they move by the same amount, keeping their order.
 */
export function shiftTimes(twins: Twin[], now: Date, staleHours = 24): void {
  const cutoff = now.getTime() - staleHours * 3.6e6;
  let newestOld = -Infinity;
  for (const t of twins)
    for (const k of TIME_KEYS) {
      const ms = timeOf(t, k);
      if (!Number.isNaN(ms) && ms < cutoff) newestOld = Math.max(newestOld, ms);
    }
  if (newestOld === -Infinity) return;
  const delta = now.getTime() - newestOld;
  for (const t of twins)
    for (const k of TIME_KEYS) {
      const ms = timeOf(t, k);
      if (!Number.isNaN(ms) && ms <= newestOld) t[k] = new Date(ms + delta).toISOString();
    }
}

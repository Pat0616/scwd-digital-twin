import "server-only";
import { AdtTwinSource } from "./adtSource";
import { FileTwinSource } from "./fileSource";
import { shiftTimes } from "./times";
import type { TwinGraph, TwinSource, TwinSourceKind } from "./types";

/** A read of the twin is shared for this long (the status watch checks every 3 s; see lib/status/watch.ts). */
export const CACHE_MS = 2_500;

let source: TwinSource | null = null;

/** TWIN_SOURCE=adt (default): the live Azure Digital Twins instance at ADT_URL. TWIN_SOURCE=file: the v4 graph export. */
function getSource(): TwinSource {
  source ??= process.env.TWIN_SOURCE === "file" ? new FileTwinSource() : new AdtTwinSource();
  return source;
}

/** TWIN_AS_OF_NOW=true moves the readings' times so the newest is now (a snapshot's readings would all look stale).
 * Defaults to on for the file source, off for the live instance. */
function asOfNow(kind: TwinSourceKind): boolean {
  const v = process.env.TWIN_AS_OF_NOW?.trim().toLowerCase();
  if (v) return v === "1" || v === "true" || v === "yes";
  return kind === "file";
}

export interface CachedGraph {
  graph: TwinGraph;
  kind: TwinSourceKind;
  /** the instance host or the file name */
  label: string;
  /** true when the reading times were moved to now (demo) */
  shifted: boolean;
  /** when the twin was read (ISO) */
  fetchedAt: string;
}

let cached: { at: number; value: CachedGraph } | null = null;
let pending: Promise<CachedGraph> | null = null;

/** The twin graph, read at most once every CACHE_MS (concurrent callers share one read). */
export async function getTwinGraph(): Promise<CachedGraph> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  pending ??= (async () => {
    try {
      const src = getSource();
      const graph = await src.graph();
      const shifted = asOfNow(src.kind);
      if (shifted) shiftTimes(graph.twins, new Date());
      const value = { graph, kind: src.kind, label: src.label, shifted, fetchedAt: new Date().toISOString() };
      cached = { at: Date.now(), value };
      return value;
    } finally {
      pending = null;
    }
  })();
  return pending;
}

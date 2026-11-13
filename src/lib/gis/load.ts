import "server-only";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { StatusGis } from "@/lib/status/compute";
import { GIS_FILES } from "./types";

const dir = () => path.join(process.cwd(), "public", "gis");

let cache: { mtime: number; data: StatusGis } | null = null;

async function read<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(path.join(dir(), file), "utf8")) as T;
}

/** The GIS layers the status rules need (which gauges, stations and pipes lie in which barangay). Re-read after
 * `npm run import-gis`. */
export async function loadStatusGis(): Promise<StatusGis> {
  const mtime = (await stat(path.join(dir(), GIS_FILES.meta))).mtimeMs;
  if (cache?.mtime === mtime) return cache.data;
  const [facilities, pipes, meters, bgyAreas] = await Promise.all([
    read<StatusGis["facilities"]>(GIS_FILES.facilities),
    read<StatusGis["pipes"]>(GIS_FILES.pipes),
    read<StatusGis["meters"]>(GIS_FILES.meters),
    read<StatusGis["bgyAreas"]>(GIS_FILES.bgyAreas),
  ]);
  cache = { mtime, data: { facilities, pipes, meters, bgyAreas } };
  return cache.data;
}

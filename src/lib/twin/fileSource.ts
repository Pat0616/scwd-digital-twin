import "server-only";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Relationship, Twin, TwinGraph, TwinSource } from "./types";

/** The twin graph as an ADT Explorer export (data/scwd_digital_twin_adt_v4.json by default, or TWIN_JSON_PATH). The
 * file is re-read whenever it changes, so editing a copy while the app runs updates the map live. */
export class FileTwinSource implements TwinSource {
  readonly kind = "file" as const;
  readonly label: string;
  private readonly file: string;
  private cache: { mtime: number; graph: TwinGraph } | null = null;

  constructor(file: string = process.env.TWIN_JSON_PATH || "data/scwd_digital_twin_adt_v4.json") {
    // a path from the environment, read at run time: not a file to bundle
    this.file = path.resolve(/*turbopackIgnore: true*/ process.cwd(), file);
    this.label = path.basename(this.file);
  }

  async graph(): Promise<TwinGraph> {
    const { mtimeMs } = await stat(this.file);
    if (this.cache?.mtime !== mtimeMs) {
      const raw = JSON.parse(await readFile(this.file, "utf8")) as {
        digitalTwinsGraph?: { digitalTwins?: Twin[]; relationships?: Relationship[] };
      };
      const g = raw.digitalTwinsGraph;
      if (!g?.digitalTwins) throw new Error(`${this.file} is not an ADT Explorer export (no digitalTwinsGraph)`);
      // an $etag per twin from the file's time, so the status watch sees the change (ADT gives real ones)
      const etag = `file-${mtimeMs}`;
      this.cache = {
        mtime: mtimeMs,
        graph: { twins: g.digitalTwins.map((t) => ({ ...t, $etag: etag })), relationships: g.relationships ?? [] },
      };
    }
    // a fresh copy: shiftTimes (source.ts) changes the times in place
    return structuredClone(this.cache.graph);
  }
}

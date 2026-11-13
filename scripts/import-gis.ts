/**
 * Imports the web export of the "Sorsogon Water Monitor" QGIS project into this app: reads its data.js
 * (window.WATER = {...}) and writes one typed JSON file per layer into public/gis/, plus the relief images next to it.
 * Re-run after every web export from QGIS (water-network plugin, Monitor panel: "Export web page…"):
 *
 *   npm run import-gis                 # reads ~/water-gis/web-monitor/data.js
 *   npm run import-gis -- path/to/data.js
 *
 * The GIS data is never edited by hand: everything here comes from the export. The only addition is each pipe's
 * dpp_twin_id (the twin id of the DPP it takes its pressure band from), found by the DPP's name.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GIS_FILES, type GisData, type GisMeta, type PipeProps } from "../src/lib/gis/types";

const root = path.resolve(__dirname, "..");
const input = path.resolve(process.argv[2] ?? path.join(os.homedir(), "water-gis", "web-monitor", "data.js"));
const outDir = path.join(root, "public", "gis");

function fail(msg: string): never {
  console.error(`import-gis: ${msg}`);
  process.exit(1);
}

type Raw = Record<string, unknown>;

function parseDataJs(file: string): Raw {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    fail(`cannot read ${file}. Export the Sorsogon Water Monitor web page from QGIS first.`);
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (!/window\.WATER\s*=/.test(text) || start < 0 || end < start) fail(`${file} does not look like a web-map data.js`);
  return JSON.parse(text.slice(start, end + 1)) as Raw;
}

function collection(w: Raw, key: string) {
  const fc = w[key] as { type?: string; features?: unknown[] } | undefined;
  if (!fc || fc.type !== "FeatureCollection" || !Array.isArray(fc.features)) fail(`"${key}" is missing or not GeoJSON`);
  return fc;
}

function need<T>(w: Raw, key: string): T {
  if (w[key] === undefined) fail(`"${key}" is missing from the export`);
  return w[key] as T;
}

const W = parseDataJs(input);
if (!W.monitor) fail(`${input} is not a Sorsogon Water Monitor export (no "monitor" key). Use the Monitor project's web export.`);

const meta: GisMeta = {
  title: need(W, "title"),
  bounds: need(W, "bounds"),
  minDischargePsi: need(W, "minDischargePsi"),
  staleHours: need(W, "staleHours"),
  bands: need(W, "bands"),
  bgyStatus: need(W, "bgyStatus"),
  roleTitles: need(W, "roleTitles"),
  meterLabels: need(W, "meterLabels"),
  pipeLabels: need(W, "pipeLabels"),
  barangays: need(W, "barangays"),
  fieldReadings: (W.fieldReadings as GisMeta["fieldReadings"] | undefined) ?? [],
  monitor: need(W, "monitor"),
};

const data = {
  meta,
  facilities: need<GisData["facilities"]>(W, "facilities"),
  pipes: collection(W, "pipes") as GisData["pipes"],
  meters: collection(W, "meters") as GisData["meters"],
  valves: collection(W, "valves") as GisData["valves"],
  zones: collection(W, "zones") as GisData["zones"],
  bgyAreas: collection(W, "bgyAreas") as GisData["bgyAreas"],
} satisfies GisData;

// each pipe shows the pressure band of its nearest DPP: link it to that DPP's twin id, so live readings recolour it
const dppTwin = new Map(data.meters.features.map((m) => [m.properties.name, m.properties.twin_id]));
let linked = 0;
for (const f of data.pipes.features) {
  const p = f.properties as PipeProps;
  p.dpp_twin_id = (p.dpp && dppTwin.get(p.dpp)) || null;
  if (p.dpp_twin_id) linked++;
}

mkdirSync(outDir, { recursive: true });
for (const [key, file] of Object.entries(GIS_FILES) as [keyof GisData, string][]) {
  writeFileSync(path.join(outDir, file), JSON.stringify(data[key]));
}
// the relief images (province and city views) sit next to data.js in the export
const reliefs: string[] = [];
for (const r of meta.monitor.relief) {
  const from = path.join(path.dirname(input), r.url);
  if (existsSync(from)) {
    copyFileSync(from, path.join(outDir, r.url));
    reliefs.push(r.url);
  } else console.warn(`  (relief image ${r.url} is not next to data.js; the map shows without it)`);
}

const inTwin = (xs: { twin_id?: string | null }[]) => xs.filter((x) => x.twin_id).length;
console.log(`import-gis: ${input} -> public/gis/`);
console.log(`  project    ${meta.title}`);
console.log(`  stations   ${data.facilities.length} (${inTwin(data.facilities)} in the twin)`);
console.log(`  pipes      ${data.pipes.features.length} (${inTwin(data.pipes.features.map((f) => f.properties))} in the twin, ${linked} linked to a DPP)`);
console.log(`  gauges     ${data.meters.features.length} (${inTwin(data.meters.features.map((f) => f.properties))} in the twin)`);
console.log(`  valves ${data.valves.features.length} · zones ${data.zones.features.length} · barangays ${data.bgyAreas.features.length} · relief ${reliefs.join(", ") || "none"}`);

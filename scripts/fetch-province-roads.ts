/**
 * TRIAL (2026-11-16): the roads of the rest of Sorsogon province, so the city view shows a road map outside Sorsogon
 * City too. The project's own Streets layer (streets.json) only covers the city: it was cut from an OpenStreetMap
 * export around the city to lay the pipes on. This fetches the province's roads from OpenStreetMap (Overpass API),
 * classes them as the QGIS plugin does (map_look.MAJOR_ROADS / MID_ROADS / MINOR_ROADS) and writes
 * public/gis/province_roads.json. Left out: the roads streets.json already has, i.e. those in the city export
 * (osm_roads_sorsogon.json) that touch Sorsogon City. That export stops at latitude 13.07, so the city's north
 * (Santo Niño, Osiao …) comes from here too.
 *
 *   npx tsx scripts/fetch-province-roads.ts                     # reads ~/water-gis/data/osm_roads_sorsogon.json
 *   npx tsx scripts/fetch-province-roads.ts D:\path\to\osm_roads_sorsogon.json
 *
 * The map draws the file when it is there; delete it to go back to the city's streets only.
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const out = path.join(root, "public", "gis", "province_roads.json");
const cityExport = path.resolve(process.argv[2] ?? path.join(os.homedir(), "water-gis", "data", "osm_roads_sorsogon.json"));
// the OSM ways the city's Streets layer was cut from
const cityWays = new Set((JSON.parse(readFileSync(cityExport, "utf8")) as { elements: { type: string; id: number }[] })
  .elements.filter((x) => x.type === "way").map((x) => x.id));

const MAJOR = ["trunk", "trunk_link", "primary", "primary_link", "secondary", "secondary_link"];
const MID = ["tertiary", "tertiary_link", "unclassified"];
const MINOR = ["residential", "living_street"];        // service roads (driveways, yards) left out: too many
const CLASS = new Map<string, string>([...MAJOR.map((h) => [h, "major"] as const), ...MID.map((h) => [h, "mid"] as const),
  ...MINOR.map((h) => [h, "minor"] as const)]);

type Ring = number[][];
type Poly = Ring[];
const munis = JSON.parse(readFileSync(path.join(root, "public", "gis", "municipalities.json"), "utf8")) as GeoJSON.FeatureCollection;

// the province's box, from its municipalities
let [w, s, e, n] = [180, 90, -180, -90];
const polysOf = (g: GeoJSON.Geometry): Poly[] => (g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : []);
for (const f of munis.features) for (const p of polysOf(f.geometry)) for (const [x, y] of p[0]!) {
  w = Math.min(w, x!); e = Math.max(e, x!); s = Math.min(s, y!); n = Math.max(n, y!);
}
const city = munis.features.filter((f) => f.properties?.name === "Sorsogon City").flatMap((f) => polysOf(f.geometry));
if (!city.length) throw new Error("Sorsogon City not found in municipalities.json");

function inRing(x: number, y: number, r: Ring): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i]!, [xj, yj] = r[j]!;
    if (yi! > y !== yj! > y && x < ((xj! - xi!) * (y - yi!)) / (yj! - yi!) + xi!) inside = !inside;
  }
  return inside;
}
const inAny = (polys: Poly[], x: number, y: number) => polys.some((p) => inRing(x, y, p[0]!) && !p.slice(1).some((h) => inRing(x, y, h)));
const inCity = (x: number, y: number) => inAny(city, x, y);
const province = munis.features.flatMap((f) => polysOf(f.geometry));
const inProvince = (x: number, y: number) => inAny(province, x, y);     // the box also takes in Albay's roads

const query = `[out:json][timeout:180];way["highway"~"^(${[...CLASS.keys()].join("|")})$"](${s},${w},${n},${e});out geom tags;`;
async function main() {
console.log(`fetch-province-roads: Overpass, box ${w.toFixed(3)},${s.toFixed(3)} .. ${e.toFixed(3)},${n.toFixed(3)}`);
let res: Response | null = null;
for (let wait = 15; ; wait *= 2) {            // the public server is often at capacity: back off and retry
  res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST", body: new URLSearchParams({ data: query }),
    headers: { "User-Agent": "water-network-monitor/1.0 (map background)" },
  });
  if (res.ok || ![429, 502, 503, 504].includes(res.status) || wait > 120) break;
  console.log(`  Overpass busy (${res.status}), retrying in ${wait} s`);
  await new Promise((r) => setTimeout(r, wait * 1000));
}
if (!res.ok) throw new Error(`Overpass: ${res.status} ${await res.text()}`);
const data = (await res.json()) as { elements: { type: string; id: number; tags?: Record<string, string>; geometry?: { lat: number; lon: number }[] }[] };

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const features: GeoJSON.Feature<GeoJSON.LineString>[] = [];
const counts: Record<string, number> = {};
let skipped = 0;
for (const el of data.elements) {
  const cls = CLASS.get(el.tags?.highway ?? "");
  if (el.type !== "way" || !cls || !el.geometry || el.geometry.length < 2) continue;
  if (!el.geometry.some((p) => inProvince(p.lon, p.lat))) continue;
  if (cityWays.has(el.id) && el.geometry.some((p) => inCity(p.lon, p.lat))) { skipped++; continue; }   // in streets.json
  features.push({ type: "Feature", properties: { name: el.tags?.name ?? null, class: cls },
    geometry: { type: "LineString", coordinates: el.geometry.map((p) => [r6(p.lon), r6(p.lat)]) } });
  counts[cls] = (counts[cls] ?? 0) + 1;
}
writeFileSync(out, JSON.stringify({ type: "FeatureCollection", features }));
console.log(`  ${features.length} roads (${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}), ` +
  `${skipped} already in the city's streets left out · ${(statSync(out).size / 1024).toFixed(0)} KB -> public/gis/province_roads.json`);
console.log("  © OpenStreetMap contributors (ODbL)");
}

main().catch((err: unknown) => { console.error(err); process.exit(1); });

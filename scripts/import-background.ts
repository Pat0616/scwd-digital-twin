/**
 * Imports the background layers of the "Sorsogon Water Monitor" QGIS project (SorsogonWater_Monitor.qgz) into
 * public/gis/, so the web map draws the same picture as QGIS instead of an online basemap:
 *
 *   Outside Mask            sorsogon_admin.gpkg | mask_extent          -> mask.json
 *   Sorsogon Municipalities monitor_municipalities.gpkg | municipalities -> municipalities.json (land, borders, names)
 *   Sorsogon Barangays      sorsogon_admin.gpkg | barangays            -> barangays.json (land, borders, names)
 *   Streets                 sorsogon_water_demo.gpkg | streets         -> streets.json
 *
 *   npm run import-background                       # reads ~/water-gis/data
 *   npm run import-background -- D:\path\to\data
 *
 * Uses ogr2ogr from the QGIS install (or OGR2OGR=path\to\ogr2ogr.exe). The sources are only read.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const dataDir = path.resolve(process.argv[2] ?? path.join(os.homedir(), "water-gis", "data"));
const outDir = path.join(root, "public", "gis");

function ogr2ogr(): string {
  if (process.env.OGR2OGR) return process.env.OGR2OGR;
  for (const base of ["C:\\Program Files", "C:\\Program Files (x86)"]) {
    if (!existsSync(base)) continue;
    const qgis = readdirSync(base).filter((d) => d.startsWith("QGIS")).sort().reverse();
    for (const d of qgis) {
      const exe = path.join(base, d, "bin", "ogr2ogr.exe");
      if (existsSync(exe)) return exe;
    }
  }
  return "ogr2ogr";           // on the PATH
}

const exe = ogr2ogr();
const env = { ...process.env, PATH: `${path.dirname(exe)}${path.delimiter}${process.env.PATH ?? ""}` };

/** [output file, gpkg, layer, SQL selecting the fields the map needs, simplify tolerance (degrees) or 0] */
const LAYERS: [string, string, string, string, number][] = [
  ["mask.json", "sorsogon_admin.gpkg", "mask_extent", "SELECT geom FROM mask_extent", 0.0002],
  ["municipalities.json", "monitor_municipalities.gpkg", "municipalities", "SELECT geom, city_name AS name FROM municipalities", 0.0002],
  ["barangays.json", "sorsogon_admin.gpkg", "barangays",
    "SELECT geom, display_name AS name, city_name AS town, barangay_id AS id FROM barangays", 0.00008],
  ["streets.json", "sorsogon_water_demo.gpkg", "streets", "SELECT geom, name, road_class AS class FROM streets", 0],
  // one label point per area, inside it (a multi-part area would otherwise be named on every islet)
  ["municipality_labels.json", "monitor_municipalities.gpkg", "municipality_labels",
    "SELECT ST_PointOnSurface(geom) AS geom, city_name AS name FROM municipalities", 0],
  ["barangay_labels.json", "sorsogon_admin.gpkg", "barangay_labels",
    "SELECT ST_PointOnSurface(geom) AS geom, display_name AS name, city_name AS town, barangay_id AS id FROM barangays WHERE city_name = 'Sorsogon City'", 0],
];

mkdirSync(outDir, { recursive: true });
console.log(`import-background: ${dataDir} -> public/gis/ (${exe})`);
for (const [out, gpkg, layer, sql, tol] of LAYERS) {
  const src = path.join(dataDir, gpkg);
  if (!existsSync(src)) {
    console.error(`  ${gpkg} not found in ${dataDir}`);
    process.exit(1);
  }
  const dst = path.join(outDir, out);
  rmSync(dst, { force: true });          // GeoJSON files cannot be overwritten in place
  const args = ["-f", "GeoJSON", dst, src, "-dialect", "SQLite", "-sql", sql, "-nln", layer, "-t_srs", "EPSG:4326",
    "-lco", "RFC7946=YES", "-lco", "COORDINATE_PRECISION=6"];
  if (tol) args.push("-simplify", String(tol));
  execFileSync(exe, args, { env, stdio: ["ignore", "ignore", "inherit"] });
  console.log(`  ${out.padEnd(20)} ${(statSync(dst).size / 1024).toFixed(0)} KB  (${gpkg} | ${layer})`);
}

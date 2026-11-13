"use client";

import { useEffect, useRef, useState } from "react";
import { GIS_FILES, type GisData } from "@/lib/gis/types";

/** Loads the static GIS once (/gis/*.json, from `npm run import-gis`), then hands the page to the monitor, which
 * listens to /api/status/stream for the live status from the digital twin. */
export default function MonitorApp() {
  const root = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(Object.entries(GIS_FILES).map(async ([key, file]) => {
        const res = await fetch(`/gis/${file}`);
        if (!res.ok) throw new Error(`/gis/${file}: ${res.status}`);
        return [key, await res.json()] as const;
      }));
      // Sorsogon's outline: not part of the QGIS export (see the README); without it the map is not held to the province
      const province = await fetch("/gis/province.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const { startMonitor } = await import("./monitor/app");
      if (!cancelled && root.current) stop = startMonitor(root.current, Object.fromEntries(entries) as unknown as GisData, province);
    })().catch((e: unknown) => {
      console.error(e);
      setError("The map data could not be loaded. Run `npm run import-gis` and reload.");
    });
    return () => { cancelled = true; stop?.(); };
  }, []);

  return (
    <div id="app" ref={root}>
      <aside id="side">
        <div className="scroll">
          <header className="top">
            <h1>Sorsogon City Water District</h1>
            <div className="status" id="status" />
            <div className="sub"><span className="live wait" /><span id="updated">Connecting to the digital twin…</span></div>
          </header>
          <input className="search" id="search" list="places" autoComplete="off"
            placeholder="🔍  Find a barangay, station or pressure point…" />
          <datalist id="places" />
          {error && <div className="note" style={{ borderColor: "var(--down)", color: "var(--down)" }}>{error}</div>}
          <div id="overview">
            <div className="cards" id="cards" />
            <div className="sec" id="attTitle">NEEDS ATTENTION</div>
            <div className="list" id="attention" />
            <div className="sec">MAP VIEW</div>
            <div className="views" id="views" />
          </div>
          <div id="detail" />
        </div>
      </aside>
      <div id="map"><div className="legend" id="legend" /><div className="city-summary" id="citySummary" /></div>
    </div>
  );
}

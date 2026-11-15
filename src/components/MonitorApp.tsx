"use client";

import { useEffect, useRef, useState } from "react";
import { GIS_FILES, type GisData } from "@/lib/gis/types";
import type { Background } from "./monitor/app";

/** The TapWater mark: a water tile with ripples and a drop (as the logo's pad), in the brand's cyan. */
function Mark() {
  return (
    <svg className="mark" viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="tw-e" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#5ee7ff" /><stop offset="1" stopColor="#0ea5e9" /></linearGradient>
        <linearGradient id="tw-d" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ffffff" /><stop offset="1" stopColor="#7dd3fc" /></linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill="#0a2148" stroke="rgba(125,175,255,.25)" />
      <path d="M17 31H47Q50 31 51.4 33.6L57 44.4Q58.6 47.5 55 47.5H9Q5.4 47.5 7 44.4L12.6 33.6Q14 31 17 31Z" fill="#06245a" stroke="url(#tw-e)" strokeWidth="2.6" />
      <ellipse cx="32" cy="40" rx="15" ry="4.2" fill="none" stroke="#22d3ee" strokeWidth="1.6" opacity=".55" />
      <ellipse cx="32" cy="40" rx="9" ry="2.6" fill="none" stroke="#38bdf8" strokeWidth="1.8" opacity=".85" />
      <ellipse cx="32" cy="40" rx="3.6" ry="1.1" fill="#bae6fd" />
      <path d="M32 9C32 9 25.5 17 25.5 21.6A6.5 6.5 0 0 0 38.5 21.6C38.5 17 32 9 32 9Z" fill="url(#tw-d)" />
    </svg>
  );
}

/** Loads the static GIS once (/gis/*.json, from `npm run import-gis`), then hands the page to the monitor, which
 * listens to /api/status/stream for the live status from the digital twin. */
export default function MonitorApp() {
  const root = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(Object.entries(GIS_FILES).map(async ([key, file]) => {
        const res = await fetch(`/gis/${file}`);
        if (!res.ok) throw new Error(`/gis/${file}: ${res.status}`);
        return [key, await res.json()] as const;
      }));
      // the QGIS project's background layers (npm run import-background); without them the map has no land
      const BG = { mask: "mask", municipalities: "municipalities", municipalityLabels: "municipality_labels",
        barangays: "barangays", barangayLabels: "barangay_labels", streets: "streets" } as const;
      const bgEntries = await Promise.all(Object.entries(BG).map(async ([key, file]) =>
        [key, await fetch(`/gis/${file}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null)] as const));
      const bg = bgEntries.every(([, v]) => v) ? (Object.fromEntries(bgEntries) as unknown as Background) : null;
      // TRIAL: the rest of the province's roads (scripts/fetch-province-roads.ts); optional, drawn when the file is there
      if (bg) bg.provinceRoads = await fetch("/gis/province_roads.json").then((r) => (r.ok ? r.json() : undefined)).catch(() => undefined);
      if (!bg) console.warn("Background layers missing: run `npm run import-background`.");
      const { startMonitor } = await import("./monitor/app");
      if (!cancelled && root.current) {
        stop = startMonitor(root.current, Object.fromEntries(entries) as unknown as GisData, bg, () => setReady(true));
      }
    })().catch((e: unknown) => {
      console.error(e);
      setError("The map data could not be loaded. Run `npm run import-gis` and reload.");
      setReady(true);
    });
    return () => { cancelled = true; stop?.(); };
  }, []);

  return (
    <>
      <div id="app" ref={root}>
        <aside id="side">
          <div className="scroll">
            <div className="brand">
              <Mark />
              <div>
                <div className="word">Tap<span>Water</span></div>
                <div className="org">Sorsogon City Water District · Network monitor</div>
              </div>
            </div>
            <header className="top">
              <h1>System status</h1>
              <div className="status" id="status" />
              <div className="sub"><span className="live wait" /><span id="updated">Connecting to the digital twin…</span></div>
            </header>
            <div className="searchwrap">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
              </svg>
              <input className="search" id="search" list="places" autoComplete="off" aria-label="Search"
                placeholder="Find a barangay, station or pressure point…" />
              <kbd>/</kbd>
            </div>
            <datalist id="places" />
            {error && <div className="note" style={{ borderColor: "var(--down-text)", color: "var(--down-text)" }}>{error}</div>}
            <div id="overview">
              <div className="cards" id="cards" />
              <div className="sec" id="attTitle">Needs attention</div>
              <div className="list" id="attention" />
              <div className="sec">Map view</div>
              <div className="views" id="views" />
            </div>
            <div id="detail" />
          </div>
        </aside>
        {/* SCADA: the top bar (map / status grid, alarm counts, clock), the stage, and the alarm console */}
        <main id="main">
          <div className="mainbar" id="mainbar" />
          <div id="stage">
            <div id="map">
              <div className="legend" id="legend" />
              <div className="toasts" id="toasts" aria-live="polite" />
            </div>
            <div id="grid" className="hp" hidden />
            <div id="faceplate" className="hp" hidden role="dialog" aria-modal="false" aria-label="Station faceplate" />
          </div>
          <section id="alarms" className="hp" aria-label="Alarms" />
        </main>
      </div>
      <div className={`splash ${ready ? "done" : ""}`} aria-hidden={ready}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a fixed brand image on the loading screen */}
        <img src="/brand/tapwater-logo.png" alt="TapWater" width={640} height={431} />
        <div className="bar2"><i /></div>
        <p>Loading the Sorsogon water network…</p>
      </div>
    </>
  );
}

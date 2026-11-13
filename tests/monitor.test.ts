import { describe, expect, it } from "vitest";
import type { Facility } from "@/lib/gis/types";
import { TwinIndex, computeStatus } from "@/lib/status/compute";
import { computeMonitor } from "@/lib/monitor/status";
import { shiftTimes as liveShift } from "@/lib/twin/times";
import { fixtureGraph, gis, shiftTimes, twin } from "./helpers";

// The Monitor project's web export (public/gis/) was made from the same v4 twin, its newest reading at this time.
const EXPORT_NOW = new Date("2026-11-13T16:09:35Z");
const G = gis();

function monitor(edit?: (g: ReturnType<typeof fixtureGraph>) => void) {
  const graph = fixtureGraph();
  shiftTimes(graph.twins, EXPORT_NOW);
  edit?.(graph);
  const base = computeStatus(graph, G, "file", EXPORT_NOW.toISOString(), EXPORT_NOW);
  return computeMonitor(new TwinIndex(graph), G, base, EXPORT_NOW);
}

describe("monitor status matches what QGIS exported (Sorsogon Water Monitor)", () => {
  const m = monitor();
  const facilities = G.facilities as Facility[];

  it("every twin station: state, headline, issues, problem parts, action, who it affects", () => {
    const twinStations = facilities.filter((f) => f.twin_id);
    expect(Object.keys(m.stations).sort()).toEqual(twinStations.map((f) => f.twin_id).sort());
    for (const f of twinStations) {
      const s = m.stations[f.twin_id!]!;
      expect([f.name, s.state, s.headline, s.issues, s.problems, s.action, s.affects, s.data, s.standby])
        .toEqual([f.name, f.state, f.headline, f.issues, f.problems, f.action, f.affects, f.data, f.standby]);
    }
  });

  it("every station card: groups, their state, issues, parts and readings", () => {
    for (const f of facilities.filter((x) => x.twin_id)) {
      const s = m.stations[f.twin_id!]!;
      const shape = (gs: Facility["groups"]) => gs.map((g) => ({
        group: g.group, title: g.title, state: g.state, issues: g.issues, parts: g.parts.map((p) => p.ok),
        key: g.key.map((r) => [r.name, r.value, r.alarm, r.offline, r.pct, r.min, r.max]),
        all: g.all.map((r) => [r.twin_id, r.property, r.value, r.alarm]),
      }));
      expect([f.name, shape(s.groups)]).toEqual([f.name, shape(f.groups)]);
    }
  });

  it("every gauge: state, headline, data health, action", () => {
    for (const { properties: g } of G.meters.features) {
      const live = m.gauges[g.twin_id!]!;
      expect([g.name, live.state, live.headline, live.data, live.action, live.affects])
        .toEqual([g.name, g.state, g.headline, g.data, g.action, g.affects]);
    }
  });

  it("every barangay: state and headline", () => {
    for (const { properties: b } of G.bgyAreas.features) {
      if (b.state == null) continue;
      expect([b.name, m.barangays[b.id]!.state, m.barangays[b.id]!.headline]).toEqual([b.name, b.state, b.headline]);
    }
  });

  it("the city's one-line summary", () => {
    expect(m.city).toEqual(G.meta.monitor.status);
  });

  it("pipes with a reported leak get the next step", () => {
    const leak = Object.entries(m.pipes).filter(([, p]) => p.alarm);
    expect(leak.length).toBeGreaterThan(0);
    for (const [, p] of leak) expect(p.action).toBe("Send a repair crew; isolate the section with its valves if the leak is big");
  });
});

describe("moving a snapshot's times to now (TWIN_AS_OF_NOW)", () => {
  it("moves the old snapshot and leaves fresh live updates as they are", () => {
    const now = new Date("2026-11-14T00:00:00Z");
    const mk = (id: string, t: string) => ({ $dtId: id, $metadata: { $model: "x" }, readings_at: t });
    const twins = [mk("old-a", "2026-11-04T01:00:00Z"), mk("old-b", "2026-11-03T19:12:00Z"), mk("fresh", "2026-11-13T23:50:00Z")];
    liveShift(twins, now);
    expect(twins.map((t) => t.readings_at)).toEqual(["2026-11-14T00:00:00.000Z", "2026-11-13T18:12:00.000Z", "2026-11-13T23:50:00Z"]);
  });
});

describe("a change in the twin shows on the monitor", () => {
  it("fixing Villa Allegre PS5's pump, drive and station clears 'Pump stopped'", () => {
    const m = monitor((g) => {
      for (const id of ["pumpstation-08-pump", "pumpstation-08-vfd", "pumpstation-08"]) {
        const t = twin(g, id);
        t.operational = true;
        delete t.issue;
      }
      twin(g, "pumpstation-08").station_status = "operating";
      twin(g, "pumpstation-08-pump").run_status = "running";
      twin(g, "pumpstation-08-vfd").fault_code = "none";
    });
    const st = m.stations["pumpstation-08"]!;
    expect(st.state).toBe("attention");
    expect(st.headline).not.toContain("Pump stopped");
    expect(st.problems.map((p) => p.group)).toEqual(["storage"]);
  });

  it("a DPP that stops reporting turns grey and counts in the city line", () => {
    const m = monitor((g) => { twin(g, "dpp-pangpang-1").pressure_sensor_online = false; });
    expect(m.gauges["dpp-pangpang-1"]).toMatchObject({ state: "nodata", headline: "Not reporting", data: "offline" });
    expect(m.city.text).toMatch(/sensors? not reporting/);
  });
});

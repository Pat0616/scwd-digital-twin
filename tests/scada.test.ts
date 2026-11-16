import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.stubEnv("SCADA_DATA_DIR", `${process.cwd()}/.scada-test-${process.pid}`);

const { acknowledge, alarmList, condition, resetAlarms, syncAlarms } = await import("@/lib/scada/alarms");
const { getHistory, recordHistory } = await import("@/lib/scada/history");
const { TwinIndex, computeStatus } = await import("@/lib/status/compute");
const { computeMonitor } = await import("@/lib/monitor/status");
const { NOW, fixtureGraph, gis, twin } = await import("./helpers");
type Live = import("@/lib/status/types").LiveResponse;

function live(mutate?: (g: ReturnType<typeof fixtureGraph>) => void): Live {
  const g = fixtureGraph();
  mutate?.(g);
  const base = computeStatus(g, gis(), "file", NOW.toISOString(), NOW);
  return { ...base, label: "fixture", shifted: false, monitor: computeMonitor(new TwinIndex(g), gis(), base, NOW) };
}
const at = (min: number) => new Date(NOW.getTime() + min * 60_000).toISOString();

describe("alarm list (ISA-18.2 states)", () => {
  beforeEach(() => resetAlarms());

  it("keeps one alarm per condition while the value changes", () => {
    expect(condition("Tank level low (22%)")).toBe("Tank level low");
    expect(condition("Pump stopped")).toBe("Pump stopped");
  });

  it("raises every current problem, unacknowledged, worst priority first", () => {
    syncAlarms(live(), gis(), at(0));
    const list = alarmList();
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((a) => !a.acked && !a.cleared)).toBe(true);
    expect(list.map((a) => a.priority)).toEqual([...list.map((a) => a.priority)].sort());
  });

  it("acknowledged and cleared leaves; cleared unacknowledged stays as returned to normal", () => {
    syncAlarms(live(), gis(), at(0));
    const [first, second] = alarmList();
    acknowledge([first!.id], at(1));
    expect(alarmList().find((a) => a.id === first!.id)?.acked).toBe(at(1));
    // a status with no problems at all: everything returns to normal
    const quiet = live();
    for (const s of Object.values(quiet.monitor.stations)) s.alarms = [];
    for (const gs of Object.values(quiet.monitor.gauges)) gs.state = "ok";
    for (const p of Object.values(quiet.monitor.pipes)) p.alarm = null;
    syncAlarms(quiet, gis(), at(2));
    expect(alarmList().find((a) => a.id === first!.id)).toBeUndefined();
    const rtn = alarmList().find((a) => a.id === second!.id)!;
    expect(rtn.cleared).toBe(at(2));
    expect(rtn.acked).toBeNull();
    acknowledge([second!.id]);
    expect(alarmList().find((a) => a.id === second!.id)).toBeUndefined();
  });

  it("a problem that comes back is raised again", () => {
    syncAlarms(live(), gis(), at(0));
    const a = alarmList()[0]!;
    acknowledge("all", at(1));
    const quiet = live();
    for (const s of Object.values(quiet.monitor.stations)) s.alarms = [];
    for (const gs of Object.values(quiet.monitor.gauges)) gs.state = "ok";
    for (const p of Object.values(quiet.monitor.pipes)) p.alarm = null;
    syncAlarms(quiet, gis(), at(2));
    syncAlarms(live(), gis(), at(3));
    const again = alarmList().find((x) => x.id === a.id)!;
    expect(again).toMatchObject({ acked: null, cleared: null, raised: at(3) });
  });

  it("a stopped pump is a priority 1 station alarm", () => {
    const s = live((g) => { twin(g, "pumpstation-01-pump").operational = false; });
    syncAlarms(s, gis(), at(0));
    expect(alarmList().find((a) => a.source === "pumpstation-01" && a.text === "Pump stopped")).toMatchObject({ kind: "station", priority: 1 });
  });
});

describe("storage tank bypass (pumping direct to the network)", () => {
  beforeEach(() => resetAlarms());

  it("a broken tank while the station delivers water is a bypass, with its own P2 alarm", () => {
    const s = live((g) => { twin(g, "pumpstation-01-storage").operational = false; });
    const st = s.monitor.stations["pumpstation-01"]!;
    expect(st.bypass).toBe("tank-out");
    expect(st.issues).toContain("Storage tank bypassed: pumping direct to the network");
    syncAlarms(s, gis(), at(0));
    expect(alarmList().find((a) => a.source === "pumpstation-01" && a.text.startsWith("Storage tank bypassed"))).toMatchObject({ priority: 2 });
  });

  it("a closed tank inlet while water still leaves is a bypass", () => {
    const s = live((g) => { twin(g, "pumpstation-01-inlet-valve").valve_position_pct_open = 0; });
    expect(s.monitor.stations["pumpstation-01"]!.bypass).toBe("inlet-closed");
  });

  it("a standby station (inlet closed, no flow) is not on bypass", () => {
    const s = live();
    expect(s.monitor.stations["pumpstation-03"]!.bypass).toBeNull();
    expect(Object.values(s.monitor.stations).every((x) => x.bypass === null)).toBe(true);
  });
});

describe("trend figures", () => {
  it("averages over time (the value held until the next sample), skipping offline gaps", async () => {
    const { trendStats } = await import("@/components/monitor/scada");
    // 10 for 1 h, offline for 1 h, 40 for 2 h, inside a 4 h window
    const h = 3.6e6;
    const s = trendStats({ t: [0, h, 2 * h], v: [10, null, 40] }, 0, 4 * h);
    expect(s).toMatchObject({ now: 40, min: 10, max: 40, n: 3 });
    expect(s.avg).toBeCloseTo((10 * 1 + 40 * 2) / 3);
    // a sample from before the window counts from the window's start
    expect(trendStats({ t: [-h, h], v: [5, 15] }, 0, 2 * h)).toMatchObject({ min: 5, max: 15, avg: 10, n: 1 });
  });
});

describe("reading history (trends)", () => {
  it("stores a steady value at most once a minute, and an offline sensor as a gap", () => {
    const s = live();
    const id = Object.keys(s.gauges).find((k) => s.gauges[k]!.kind === "pressure")!;
    const key = `${id}|pressure_psi`;
    const t0 = Date.parse(at(100));
    recordHistory(s, new Date(t0).toISOString());
    recordHistory(s, new Date(t0 + 3_000).toISOString());          // same value 3 s later: skipped
    recordHistory(s, new Date(t0 + 61_000).toISOString());         // a minute later: stored again
    s.gauges[id]!.online = false;
    recordHistory(s, new Date(t0 + 64_000).toISOString());         // offline: a gap
    const h = getHistory(key, t0 - 1);
    expect(h.t.filter((t) => t >= t0)).toEqual([t0, t0 + 61_000, t0 + 64_000]);
    expect(h.v.at(-1)).toBeNull();
  });
});

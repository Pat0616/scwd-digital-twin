import { describe, expect, it } from "vitest";
import { TwinIndex, computeStatus } from "@/lib/status/compute";
import { twinDetail } from "@/lib/status/detail";
import { NOW, fixtureGraph, gis, shiftTimes, twin } from "./helpers";

const G = gis();
const status = (graph = fixtureGraph()) => computeStatus(graph, G, "adt", NOW.toISOString(), NOW);

describe("live status from the twin fixture", () => {
  const s = status();

  it("Villa Allegre PS5: down, '!' on the pump logo, with its tank and outlet alarms", () => {
    const st = s.stations["pumpstation-08"]!;
    expect(st.status).toBe("offline");
    expect(st.alarm).toBe("Pump stopped on VFD overcurrent fault");
    expect(st.alert_slot).toBe(2);                         // source, treatment, [pumping], storage, generator
    expect(st.alerts).toBe(5);                             // pump, VFD, tank, outlet + the station itself
    expect(st.parts["pumpstation-08-pump"]).toEqual({ status: "offline", alarm: "Tripped on overcurrent" });
    expect(st.parts["pumpstation-08-storage"]!.alarm).toBe("Storage tank level 22 % (min 25)");
    expect(st.parts["pumpstation-08-outlet"]!.alarm).toBe("Outlet pressure 6 psi (min 7)");
  });

  it("Pamurayan PS: '!' on the chlorination logo (sensor offline), low generator fuel", () => {
    const st = s.stations["pumpstation-12"]!;
    expect(st.status).toBe("operational");
    expect(st.alert_slot).toBe(1);
    expect(st.alerts).toBe(2);
    expect(st.parts["pumpstation-12-chlorine-tank"]!.alarm).toBe("Chlorine tank level: sensor offline");
    expect(st.parts["pumpstation-12-generator"]!.alarm).toBe("Generator fuel level 18 % (min 25)");
  });

  it("the other stations have no alert", () => {
    for (const [id, st] of Object.entries(s.stations))
      if (!["pumpstation-08", "pumpstation-12"].includes(id)) expect([id, st.alert_slot, st.alerts]).toEqual([id, null, 0]);
  });

  it("groups each station's readings by logo, in logo order", () => {
    const groups = s.stations["pumpstation-08"]!.sensors;
    expect(groups.map((x) => x.role)).toEqual(["treatment", "pumping", "storage", "generator"]);
    expect(groups.find((x) => x.role === "storage")!.items.find((i) => i.type === "level"))
      .toMatchObject({ name: "Storage tank level", value: "22 %", alarm: "Storage tank level 22 % (min 25)" });
  });

  it("gauges: values, bands, alarms and the offline one", () => {
    expect(s.gauges["dpp-san-juan-3"]).toMatchObject({ value: 1.5, band: "very_low", online: true });
    expect(s.gauges["dpp-pangpang-2"]).toMatchObject({ value: 5.8, band: "low" });
    expect(s.gauges["farpoint-bibincahan"]).toMatchObject({ kind: "chlorine", value: 0.25, band: null,
      alarm: "Far-point chlorine residual, Bibincahan 0.25 ppm (min 0.3)" });
    expect(s.gauges["dpp-cabid-an-3"]).toMatchObject({ online: false, status: "offline", band: "stale" });
    expect(Object.keys(s.gauges)).toHaveLength(136);
  });

  it("the Pangpang distribution pipe carries the leak", () => {
    expect(s.pipes["pangpang-distribution"]).toEqual({ alarm: "Mainline leak reported; awaiting repair" });
    expect(s.pipes["san-juan-distribution"]).toEqual({ alarm: null });
  });

  it("barangays: San Juan very low, Pangpang low, alerts in Bibincahan, Cabid-An and Pamurayan", () => {
    // the Monitor project has barangays of other towns too (e.g. another San Juan): the city's own
    const b = (name: string) => s.barangays[G.bgyAreas.features.find((f) => f.properties.name === name &&
      f.properties.town === "Sorsogon City")!.properties.id]!;
    expect(b("San Juan")).toMatchObject({ status: "very_low", psi: 1.5 });
    expect(b("Pangpang")).toMatchObject({ status: "low", psi: 5.8 });
    expect(b("Bibincahan").status).toBe("station_alert");
    expect(b("Cabid-An").status).toBe("station_alert");
    expect(b("Pamurayan").status).toBe("station_alert");
    expect(b("Maricrum").status).toBe("normal");
    expect(b("San Isidro").status).toBe("normal");
    // twin v4 gives every served barangay its DPPs (Abuyog had none before)
    expect(b("Abuyog")).toMatchObject({ status: "normal", label: "Normal" });
  });

  it("matches the statuses QGIS exported for every barangay", () => {
    // (an area that is not served keeps that status on the map, even when it shares its id with a served one)
    for (const { properties: p } of G.bgyAreas.features)
      if (p.status !== "not_served") expect([p.name, s.barangays[p.id]!.status]).toEqual([p.name, p.status]);
  });
});

describe("a change in the twin clears its alert on the next read", () => {
  it("fixing the Villa Allegre pump removes its alarm", () => {
    const g = fixtureGraph();
    const pump = twin(g, "pumpstation-08-pump");
    pump.operational = true;
    delete pump.issue;
    const st = status(g).stations["pumpstation-08"]!;
    expect(st.parts["pumpstation-08-pump"]).toEqual({ status: "operational", alarm: null });
    expect(st.alerts).toBe(4);
  });

  it("with the drive and the station back too, the '!' moves to the storage logo", () => {
    const g = fixtureGraph();
    for (const id of ["pumpstation-08-pump", "pumpstation-08-vfd", "pumpstation-08"]) {
      const t = twin(g, id);
      t.operational = true;
      delete t.issue;
    }
    twin(g, "pumpstation-08").station_status = "operating";
    const st = status(g).stations["pumpstation-08"]!;
    expect(st.status).toBe("operational");
    expect(st.alert_slot).toBe(3);
  });

  it("a reading whose value has not changed for days still counts while its sensor is online", () => {
    const g = fixtureGraph();
    shiftTimes(g.twins, new Date(NOW.getTime() - 10 * 24 * 3.6e6));
    const s = status(g);
    const dpp = Object.values(s.gauges).find((x) => x.kind === "pressure" && x.online && x.value != null)!;
    expect(dpp.band).not.toBe("stale");
    expect(Object.values(s.gauges).filter((x) => x.kind === "pressure" && !x.online).every((x) => x.band === "stale")).toBe(true);
  });
});

describe("twin detail", () => {
  it("lists a station's parts and readings", () => {
    const g = fixtureGraph();
    const d = twinDetail(new TwinIndex(g), "pumpstation-08", g.relationships)!;
    expect(d.model).toBe("PumpingStation");
    expect(d.parts).toHaveLength(15);
    expect(d.parts.find((p) => p.id === "pumpstation-08-pump")).toMatchObject({ role: "pumping", status: "offline",
      props: { rated_hp: 15, rated_discharge_lps: 8 } });
    expect(d.readings).toHaveLength(18);
    expect(twinDetail(new TwinIndex(g), "nope", g.relationships)).toBeNull();
  });
});

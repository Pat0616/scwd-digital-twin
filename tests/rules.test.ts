import { describe, expect, it } from "vitest";
import {
  alarmText, bandFor, bgyStatus, fmtG, gaugeBand, modelName, readingText, stationAlerts,
} from "@/lib/status/rules";
import { fixtureGraph, reading, twin } from "./helpers";

const g = fixtureGraph();

describe("alarm text (twin_sync.alarm_text)", () => {
  it("names the value, unit and the limit it broke", () => {
    expect(alarmText(reading(g, "pumpstation-08-storage", "level_pct"))).toBe("Storage tank level 22 % (min 25)");
    expect(alarmText(reading(g, "pumpstation-08-outlet", "pressure_psi"))).toBe("Outlet pressure 6 psi (min 7)");
    expect(alarmText(reading(g, "pumpstation-12-generator", "fuel_level_pct"))).toBe("Generator fuel level 18 % (min 25)");
    expect(alarmText(reading(g, "farpoint-bibincahan", "chlorine_residual_ppm")))
      .toBe("Far-point chlorine residual, Bibincahan 0.25 ppm (min 0.3)");
    expect(alarmText(reading(g, "dpp-san-juan-3", "pressure_psi"))).toBe("San Juan DPP 3 pressure 1.5 psi (min 7)");
  });

  it("reports a reading whose sensor is offline, whatever its last value", () => {
    expect(alarmText(reading(g, "pumpstation-12-chlorine-tank", "level_pct"))).toBe("Chlorine tank level: sensor offline");
    expect(alarmText(reading(g, "dpp-cabid-an-3", "pressure_psi"))).toBe("Cabid-An DPP 3 pressure: sensor offline");
  });

  it("is null for a reading in range", () => {
    expect(alarmText(reading(g, "pumpstation-01-storage", "level_pct"))).toBeNull();
    expect(alarmText(reading(g, "pumpstation-08-pump", "run_status"))).toBeNull();
  });

  it("names the max limit too", () => {
    expect(alarmText({ display_name: "Chlorine", in_alarm: true, value_number: 2, unit: "ppm", max_value: 1.5 }))
      .toBe("Chlorine 2 ppm (max 1.5)");
    expect(alarmText({ kind: "fault_code", in_alarm: true, value_text: "OC" })).toBe("fault_code OC");
  });
});

describe("reading text and number formatting", () => {
  it("writes numbers as Python's :g", () => {
    expect(fmtG(22)).toBe("22");
    expect(fmtG(0.25)).toBe("0.25");
    expect(fmtG(15.16)).toBe("15.16");
    expect(fmtG(0.1 + 0.2)).toBe("0.3");
    expect(fmtG(1e6)).toBe("1e+06");
  });
  it("shows number + unit, text or yes/no", () => {
    expect(readingText(reading(g, "pumpstation-08-outlet", "flow_lps"))).toBe("4.1 lps");
    expect(readingText(reading(g, "pumpstation-08-vfd", "fault_code"))).toBe("OC");
    expect(readingText(reading(g, "pumpstation-12-grid", "power_present"))).toBe("no");
    expect(readingText({})).toBe("—");
  });
  it("reads the model name from the DTMI", () => {
    expect(modelName(twin(g, "pumpstation-08-storage"))).toBe("StorageTank");
  });
});

describe("pressure bands (SCWD minimum 7 psi)", () => {
  it.each([
    [0, "very_low"], [1.5, "very_low"], [2.99, "very_low"], [3, "low"], [5.8, "low"], [6.99, "low"],
    [7, "ok"], [32, "ok"], [79.9, "ok"], [80, "high"], [120, "high"],
  ] as const)("%s psi is %s", (psi, band) => expect(bandFor(psi, 0)).toBe(band));

  it("no value is no reading; an old reading is stale", () => {
    expect(bandFor(null, 0)).toBe("none");
    expect(bandFor(14.5, 25)).toBe("stale");
    expect(bandFor(14.5, 24)).toBe("ok");
    expect(bandFor(14.5, null)).toBe("ok");
  });

  it("an offline gauge counts as no current reading", () => {
    expect(gaugeBand(9.6, 1, false)).toBe("stale");
    expect(gaugeBand(9.6, 1, true)).toBe("ok");
    expect(gaugeBand(null, 1, false)).toBe("none");
  });
});

describe("logo slot of the red '!'", () => {
  const all = ["source", "treatment", "pumping", "storage", "generator"] as const;
  const ok = (role: (typeof all)[number]) => ({ role, offline: false, alarm: null });

  it("goes on the first logo, in role order, with a problem", () => {
    const parts = [ok("source"), { role: "storage" as const, offline: false, alarm: "low" },
      { role: "pumping" as const, offline: true, alarm: null }, ok("generator")];
    expect(stationAlerts(parts, [...all], true)).toEqual({ alerts: 3, slot: 2 });
  });
  it("counts the logos the station actually has", () => {
    expect(stationAlerts([{ role: "storage", offline: true, alarm: null }], ["source", "storage"], false))
      .toEqual({ alerts: 1, slot: 1 });
  });
  it("goes on the roof corner when the station is down without a part to blame", () => {
    expect(stationAlerts([ok("source")], [...all], true)).toEqual({ alerts: 1, slot: -1 });
  });
  it("is absent when everything works", () => {
    expect(stationAlerts(all.map(ok), [...all], false)).toEqual({ alerts: 0, slot: null });
  });
});

describe("barangay status (map_look._bgy_status)", () => {
  it("takes the worst that applies", () => {
    expect(bgyStatus(new Set(["ok", "very_low", "low"]), 3, true)).toBe("very_low");
    expect(bgyStatus(new Set(["ok", "low"]), 3, true)).toBe("low");
    expect(bgyStatus(new Set(["ok", "high"]), 1, true)).toBe("station_alert");
    expect(bgyStatus(new Set(["ok", "high"]), 0, true)).toBe("high");
    expect(bgyStatus(new Set(["ok", null]), 0, true)).toBe("normal");
    expect(bgyStatus(new Set(["stale"]), 0, true)).toBe("no_reading");
    expect(bgyStatus(new Set([null]), 0, true)).toBe("no_gauge");
    expect(bgyStatus(new Set(["very_low"]), 9, false)).toBe("not_served");
  });
});

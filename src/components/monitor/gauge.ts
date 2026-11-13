// A Designated Pressure Point as a pressure gauge (monitor_style.gauge_svg): a 0-20 psi dial whose needle points to
// the reading, the part below SCWD's 7 psi minimum tinted, the reading's arc and the ring in the state colour.
// Not reporting: a grey dashed dial with a ? and no needle. Drawn in the browser so live readings move the needle.

import type { MonState } from "@/lib/gis/types";

const GAUGE_MAX_PSI = 20;
const INK = "#1d3557", TEXT = "#475569";

export function gaugeSvg(psi: number | null, state: MonState, colours: Record<string, string>): string {
  const cx = 12, cy = 12.6, r = 7;
  const colour = colours[state] ?? colours.nodata ?? "#94a3b8";
  const angle = (p: number | null) => -120 + 240 * Math.max(0, Math.min(1, (p ?? 0) / GAUGE_MAX_PSI));
  const pt = (a: number, rad: number): [number, number] =>
    [cx + rad * Math.sin((a * Math.PI) / 180), cy - rad * Math.cos((a * Math.PI) / 180)];
  const arc = (a0: number, a1: number, rad = r) => {
    const [x0, y0] = pt(a0, rad), [x1, y1] = pt(a1, rad);
    return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${rad} ${rad} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  };
  const face = `<circle cx="12" cy="12.4" r="10.6" fill="#ffffff" stroke="${colour}" stroke-width="2.2"` +
    (state === "nodata" ? ' stroke-dasharray="3 2.2"' : "") + "/>";
  const track = `<path d="${arc(-120, 120)}" fill="none" stroke="#e2e8f0" stroke-width="2.3" stroke-linecap="round"/>`;
  const low = `<path d="${arc(-120, angle(7))}" fill="none" stroke="#fecaca" stroke-width="2.3" stroke-linecap="round"/>`;
  let body: string;
  if (state === "nodata" || psi == null) {
    body = face + track +
      `<path d="M9.4 9.8a2.6 2.6 0 1 1 3.8 2.3c-.8.4-1.2.9-1.2 1.8v.6" fill="none" stroke="${TEXT}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` +
      `<circle cx="12" cy="17.2" r="1.3" fill="${TEXT}"/>`;
  } else {
    const a = angle(psi);
    const value = `<path d="${arc(-120, Math.max(a, -119))}" fill="none" stroke="${colour}" stroke-width="2.3" stroke-linecap="round"/>`;
    const [nx, ny] = pt(a, 6.2);
    const needle = `<path d="M${cx} ${cy}L${nx.toFixed(2)} ${ny.toFixed(2)}" stroke="${INK}" stroke-width="1.7" stroke-linecap="round"/>` +
      `<circle cx="${cx}" cy="${cy}" r="1.7" fill="${INK}"/>`;
    body = face + track + low + value + needle;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">${body}</svg>`;
}

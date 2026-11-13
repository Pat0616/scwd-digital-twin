// GET /api/twin/[id]: one twin with its parts and readings, for the details drawer.

import type { Reading, Role } from "@/lib/gis/types";
import { isReadingKey } from "@/lib/twin/readings";
import type { Twin } from "@/lib/twin/types";
import { issueOf, partStatus, toReading, type TwinIndex } from "./compute";
import { ROLE_OF_MODEL, modelName } from "./rules";
import type { PartStatus } from "./types";

type Props = Record<string, string | number | boolean>;

export interface TwinPartDetail extends PartStatus {
  id: string;
  model: string;
  role: Role | null;
  name: string | null;
  /** the part's own properties (specs), without the ADT metadata, status fields and readings */
  props: Props;
}

export interface TwinDetail {
  id: string;
  model: string;
  name: string | null;
  props: Props;
  parts: TwinPartDetail[];
  /** the readings of the twin and its parts (twin_id = the part each reading is a property of) */
  readings: (Reading & { role: Role | null })[];
  /** other relationships of the twin (serves, locatedIn …), with the other twin's display name */
  related: { name: string; direction: "out" | "in"; id: string; label: string | null }[];
}

const HIDDEN = new Set(["display_name", "operational", "issue"]);

/** A twin's plain properties (no $-metadata, no nested objects, no readings). */
function ownProps(t: Twin): Props {
  const out: Props = {};
  for (const [k, v] of Object.entries(t))
    if (!k.startsWith("$") && !HIDDEN.has(k) && !isReadingKey(k) && (typeof v === "string" || typeof v === "number" || typeof v === "boolean"))
      out[k] = v;
  return out;
}

export function twinDetail(idx: TwinIndex, id: string, relationships: { $sourceId: string; $targetId: string; $relationshipName: string }[]): TwinDetail | null {
  const twin = idx.twins.get(id);
  if (!twin) return null;
  const parts = idx.partsOf.get(id) ?? [];
  const name = (t: Twin) => (typeof t.display_name === "string" ? t.display_name : null);
  const role = (t: Twin | undefined) => ROLE_OF_MODEL[modelName(t)] ?? null;
  return {
    id, model: modelName(twin), name: name(twin), props: { ...ownProps(twin), ...(issueOf(twin) ? { issue: issueOf(twin)! } : {}) },
    parts: parts.map((p) => ({
      id: p.$dtId, model: modelName(p), role: role(p), name: name(p), props: ownProps(p),
      ...partStatus(p, idx.readingsOf(p.$dtId)),
    })),
    readings: [id, ...parts.map((p) => p.$dtId)].flatMap((target) =>
      idx.readingsOf(target).map((r) => ({ ...toReading(r), role: role(idx.twins.get(target)) }))),
    related: relationships
      .filter((r) => (r.$sourceId === id || r.$targetId === id) && r.$relationshipName !== "partOf")
      .map((r) => {
        const out = r.$sourceId === id, other = out ? r.$targetId : r.$sourceId, t = idx.twins.get(other);
        return { name: r.$relationshipName, direction: out ? "out" as const : "in" as const, id: other, label: t ? name(t) : null };
      }),
  };
}

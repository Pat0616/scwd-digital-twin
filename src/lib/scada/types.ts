// What the SCADA screens get from the server: the shared alarm list and a reading's history (trends).

/** 1 high (not working), 2 medium (needs attention), 3 low (no current data). */
export type AlarmPriority = 1 | 2 | 3;
export type AlarmKind = "station" | "gauge" | "pipe";

export interface Alarm {
  /** `${source twin id}|${condition}`: the same problem keeps its alarm while its value changes */
  id: string;
  /** the station, gauge or pipe twin id */
  source: string;
  kind: AlarmKind;
  name: string;
  /** the latest wording, with the value */
  text: string;
  /** the station's equipment group, if any */
  group: string | null;
  priority: AlarmPriority;
  /** when it was raised (ISO) */
  raised: string;
  /** when it returned to normal (ISO); null while active */
  cleared: string | null;
  /** when an operator acknowledged it (ISO); null while unacknowledged */
  acked: string | null;
}

/** One reading's samples: times (ms) and values (null: the sensor was offline). */
export interface History {
  key: string;
  t: number[];
  v: (number | null)[];
}

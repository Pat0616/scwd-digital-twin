// The digital twin's graph, as Azure Digital Twins returns it (and as ADT Explorer exports it).

export interface Twin {
  $dtId: string;
  $metadata: { $model: string; [k: string]: unknown };
  display_name?: string;
  [property: string]: unknown;
}

export interface Relationship {
  $relationshipId: string;
  $sourceId: string;
  $targetId: string;
  $relationshipName: string;
  [property: string]: unknown;
}

export interface TwinGraph {
  twins: Twin[];
  relationships: Relationship[];
}

/** Where the twin comes from: the live Azure Digital Twins instance, or an ADT Explorer export of it (the v4 graph). */
export type TwinSourceKind = "adt" | "file";

export interface TwinSource {
  readonly kind: TwinSourceKind;
  /** A short description for logs and the page badge, e.g. the instance host (never secrets). */
  readonly label: string;
  graph(): Promise<TwinGraph>;
}

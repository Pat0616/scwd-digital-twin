import "server-only";
import { DigitalTwinsClient } from "@azure/digital-twins-core";
import { DefaultAzureCredential } from "@azure/identity";
import type { Relationship, Twin, TwinGraph, TwinSource } from "./types";

/**
 * The live Azure Digital Twins instance at ADT_URL, queried on the server only.
 * DefaultAzureCredential signs in with AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET (a service principal
 * with the "Azure Digital Twins Data Reader" role) when set, otherwise with the local `az login` session.
 */
export class AdtTwinSource implements TwinSource {
  readonly kind = "adt" as const;
  readonly label: string;
  private readonly client: DigitalTwinsClient;

  constructor(url: string | undefined = process.env.ADT_URL) {
    if (!url) throw new Error("ADT_URL (the Azure Digital Twins instance URL) is not set in .env.local");
    const endpoint = url.startsWith("http") ? url.replace(/\/+$/, "") : `https://${url.replace(/\/+$/, "")}`;
    this.label = new URL(endpoint).host;
    this.client = new DigitalTwinsClient(endpoint, new DefaultAzureCredential());
  }

  /** Every row of a query; the iterator follows the continuation tokens (paging). */
  private async all<T>(query: string): Promise<T[]> {
    const rows: T[] = [];
    for await (const row of this.client.queryTwins(query)) rows.push(row as T);
    return rows;
  }

  async graph(): Promise<TwinGraph> {
    const [twins, relationships] = await Promise.all([
      this.all<Twin>("SELECT * FROM digitaltwins"),
      this.all<Relationship>("SELECT * FROM relationships"),
    ]);
    return { twins, relationships };
  }
}

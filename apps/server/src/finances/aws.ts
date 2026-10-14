import { AwsClient } from "aws4fetch";
import type { Config } from "../config";

export interface AwsCostLine {
  day: string;
  service: string;
  amountMicro: number;
  category: "infrastructure" | "storage" | "email";
}

/** Maps AWS service names to public cost categories. */
export function categoryFor(service: string): AwsCostLine["category"] {
  if (/Simple Storage Service|\bS3\b/i.test(service)) return "storage";
  if (/Simple Email Service|\bSES\b/i.test(service)) return "email";
  return "infrastructure";
}

/** Parses a Cost Explorer GetCostAndUsage response (DAILY, grouped by SERVICE). */
export function parseCostExplorer(json: {
  ResultsByTime?: { TimePeriod: { Start: string }; Groups?: { Keys: string[]; Metrics: Record<string, { Amount: string; Unit: string }> }[] }[];
}): AwsCostLine[] {
  const out: AwsCostLine[] = [];
  for (const r of json.ResultsByTime ?? []) {
    for (const g of r.Groups ?? []) {
      const m = g.Metrics.UnblendedCost ?? Object.values(g.Metrics)[0];
      if (!m || m.Unit !== "USD") continue;
      const amountMicro = Math.round(Number(m.Amount) * 1_000_000);
      if (amountMicro <= 0) continue;
      const service = g.Keys[0] ?? "AWS";
      out.push({ day: r.TimePeriod.Start, service, amountMicro, category: categoryFor(service) });
    }
  }
  return out;
}

/** Fetches daily costs by service for [start, end) from AWS Cost Explorer (us-east-1). */
export async function fetchAwsCosts(config: Config, start: string, end: string): Promise<AwsCostLine[]> {
  const aws = new AwsClient({
    accessKeyId: config.AWS_ACCESS_KEY_ID,
    secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
    region: "us-east-1",
    service: "ce",
  });
  const res = await aws.fetch("https://ce.us-east-1.amazonaws.com/", {
    method: "POST",
    headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "AWSInsightsIndexService.GetCostAndUsage" },
    body: JSON.stringify({
      TimePeriod: { Start: start, End: end },
      Granularity: "DAILY",
      Metrics: ["UnblendedCost"],
      GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
    }),
  });
  if (!res.ok) throw new Error(`Cost Explorer ${res.status}: ${await res.text()}`);
  return parseCostExplorer(await res.json());
}

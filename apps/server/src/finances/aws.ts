import { AwsClient } from "aws4fetch";
import type { Config } from "../config";

export interface AwsCostLine {
  day: string;
  service: string;
  /** List price (usage before credits). */
  amountMicro: number;
  category: "infrastructure" | "storage" | "email";
  /** AWS credits covered this line, so nothing was actually paid. */
  paidByCredits: boolean;
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
      out.push({ day: r.TimePeriod.Start, service, amountMicro, category: categoryFor(service), paidByCredits: false });
    }
  }
  return out;
}

/**
 * Fetches daily costs by service for [start, end) from AWS Cost Explorer (us-east-1),
 * at list price (usage records only, before credits), in the hosting region plus
 * AWS's global items (Cost Explorer itself, Route 53). Lines that credits covered
 * are flagged, so the public page can show them at list price, "paid by AWS credits".
 */
export async function fetchAwsCosts(config: Config, start: string, end: string): Promise<AwsCostLine[]> {
  const aws = new AwsClient({
    accessKeyId: config.AWS_ACCESS_KEY_ID,
    secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
    region: "us-east-1",
    service: "ce",
  });
  const query = async (recordType: "Usage" | "Credit") => {
    const res = await aws.fetch("https://ce.us-east-1.amazonaws.com/", {
      method: "POST",
      headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "AWSInsightsIndexService.GetCostAndUsage" },
      body: JSON.stringify({
        TimePeriod: { Start: start, End: end },
        Granularity: "DAILY",
        Metrics: ["UnblendedCost"],
        GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
        Filter: {
          And: [
            { Dimensions: { Key: "RECORD_TYPE", Values: [recordType] } },
            { Dimensions: { Key: "REGION", Values: [config.AWS_COST_REGION, "global", "NoRegion"] } },
          ],
        },
      }),
    });
    if (!res.ok) throw new Error(`Cost Explorer ${res.status}: ${await res.text()}`);
    return res.json();
  };
  const usage = parseCostExplorer(await query("Usage"));
  // Credits come back as negative amounts per service and day.
  const credits = new Map<string, number>();
  for (const r of (await query("Credit")).ResultsByTime ?? []) {
    for (const g of r.Groups ?? []) {
      const m = g.Metrics.UnblendedCost;
      if (m?.Unit === "USD") credits.set(`${r.TimePeriod.Start}|${g.Keys[0]}`, -Math.round(Number(m.Amount) * 1_000_000));
    }
  }
  return usage.map((l) => ({ ...l, paidByCredits: (credits.get(`${l.day}|${l.service}`) ?? 0) >= l.amountMicro - 1 }));
}

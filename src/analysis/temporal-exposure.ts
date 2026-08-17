import neo4j from "neo4j-driver";
import { runQuery } from "../db/connection.js";
import { QUERIES } from "../db/queries.js";
import { nodeId } from "../db/node-id.js";

export interface ExposureWindow {
  packageName: string;
  compromisedAt: string;
  detectedAt: string;
  versionsPublished: Array<{ version: string; publishedAt: string }>;
  consumersExposed: string[];
  windowDurationHours: number;
}

const int = neo4j.int;

function asString(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}

/**
 * Which versions were published inside the compromise window, and which
 * consumers depend on the package (and so could have resolved a bad version
 * while it was live). The window filter is applied here rather than in Cypher:
 * ISO 8601 timestamps sort lexicographically, so a string comparison is a
 * correct time comparison, and it keeps the query within the row-projection
 * surface HydraDB supports.
 */
export async function analyzeTemporalExposure(
  packageName: string,
  compromisedAt: string,
  detectedAt: string,
): Promise<ExposureWindow> {
  const id = nodeId("package", packageName);

  const [versions, consumers] = await Promise.all([
    runQuery<{ version: string; publishedAt: string }>(
      QUERIES.packageVersions,
      { id: int(id) },
    ),
    runQuery<{ name: string }>(QUERIES.directConsumers, { id: int(id) }),
  ]);

  const inWindow = versions
    .map((v) => ({
      version: asString(v.version),
      publishedAt: asString(v.publishedAt),
    }))
    .filter(
      (v) =>
        v.publishedAt >= compromisedAt && v.publishedAt <= detectedAt,
    )
    .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));

  const consumerNames = [
    ...new Set(consumers.map((c) => asString(c.name)).filter(Boolean)),
  ].sort();

  const start = new Date(compromisedAt).getTime();
  const end = new Date(detectedAt).getTime();
  const windowHours = (end - start) / (1000 * 60 * 60);

  return {
    packageName,
    compromisedAt,
    detectedAt,
    versionsPublished: inWindow,
    consumersExposed: consumerNames,
    windowDurationHours: Math.round(windowHours * 10) / 10,
  };
}

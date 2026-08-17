import neo4j from "neo4j-driver";
import { runQuery } from "../db/connection.js";
import { QUERIES } from "../db/queries.js";
import type { IdRegistry } from "../db/id-registry.js";

export interface ExposureWindow {
  packageName: string;
  compromisedAt: string;
  detectedAt: string;
  versionsPublished: Array<{ version: string; publishedAt: string }>;
  consumersExposed: string[];
  windowDurationHours: number;
  /**
   * The first version published inside the window: the earliest release that
   * could carry the compromise, and the answer to the track's "which version
   * introduced the vulnerability". Undefined when nothing shipped in the window.
   */
  firstSuspectVersion?: { version: string; publishedAt: string };
  /** The last known-good release, published immediately before the window. */
  lastCleanVersion?: { version: string; publishedAt: string };
  /** Total versions known for this package, for context on the two above. */
  versionsKnown: number;
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
  registry: IdRegistry,
  packageName: string,
  compromisedAt: string,
  detectedAt: string,
): Promise<ExposureWindow> {
  const id = registry.lookup("package", packageName);
  if (id === undefined) {
    const start = new Date(compromisedAt).getTime();
    const end = new Date(detectedAt).getTime();
    return {
      packageName,
      compromisedAt,
      detectedAt,
      versionsPublished: [],
      consumersExposed: [],
      windowDurationHours: Math.round(((end - start) / 3.6e6) * 10) / 10,
      versionsKnown: 0,
    };
  }

  // Sequential, NOT Promise.all. See the note in blast-radius.ts: concurrent
  // queries on the same connection intermittently corrupt the Bolt decode.
  const versions = await runQuery<{ version: string; publishedAt: string }>(
    QUERIES.packageVersions,
    { id: int(id) },
  );
  const consumers = await runQuery<{ name: string }>(QUERIES.directConsumers, {
    id: int(id),
  });

  const all = versions
    .map((v) => ({
      version: asString(v.version),
      publishedAt: asString(v.publishedAt),
    }))
    .filter((v) => v.version && v.publishedAt)
    // ISO 8601 sorts correctly as text, so this is a real chronological sort.
    .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));

  const inWindow = all.filter(
    (v) => v.publishedAt >= compromisedAt && v.publishedAt <= detectedAt,
  );

  // The last release BEFORE the window is the newest version known to predate
  // the compromise, which is what a responder pins back to.
  const before = all.filter((v) => v.publishedAt < compromisedAt);
  const lastCleanVersion = before[before.length - 1];

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
    firstSuspectVersion: inWindow[0],
    lastCleanVersion,
    versionsKnown: all.length,
  };
}

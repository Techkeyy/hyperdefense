import neo4j from "neo4j-driver";
import { runQuery } from "../db/connection.js";
import { QUERIES, downstreamBlastRadiusQuery } from "../db/queries.js";
import type { IdRegistry } from "../db/id-registry.js";

export interface BlastRadiusResult {
  found: boolean;
  downstream: Array<{ name: string }>;
  lateralMovement: Array<{ maintainer: string; atRiskPackages: string[] }>;
  totalAffected: number;
}

const int = neo4j.int;

function asString(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}

export async function analyzeBlastRadius(
  registry: IdRegistry,
  packageName: string,
  maxDepth = 10,
): Promise<BlastRadiusResult> {
  const id = registry.lookup("package", packageName);
  if (id === undefined) {
    return { found: false, downstream: [], lateralMovement: [], totalAffected: 0 };
  }

  const [downstream, lateral] = await Promise.all([
    // Variable-length source id must be a literal, so this query is built with
    // the id interpolated rather than passed as a parameter.
    runQuery<{ name: string }>(downstreamBlastRadiusQuery(id, maxDepth)),
    // Fixed-length pattern: $id parameter is accepted.
    runQuery<{ maintainer: string; otherNames: string[] }>(
      QUERIES.sharedMaintainerRisk,
      { id: int(id) },
    ),
  ]);

  const affected = new Set<string>();

  const downstreamSeen = new Set<string>();
  const downstreamList: Array<{ name: string }> = [];
  for (const row of downstream) {
    const name = asString(row.name);
    if (!name || downstreamSeen.has(name)) continue;
    downstreamSeen.add(name);
    affected.add(name);
    downstreamList.push({ name });
  }

  const byMaintainer = new Map<string, Set<string>>();
  for (const row of lateral) {
    const maintainer = asString(row.maintainer);
    const names = Array.isArray(row.otherNames) ? row.otherNames : [];
    const set = byMaintainer.get(maintainer) ?? new Set<string>();
    for (const n of names) {
      const name = asString(n);
      if (name && name !== packageName) {
        set.add(name);
        affected.add(name);
      }
    }
    byMaintainer.set(maintainer, set);
  }

  const lateralList = [...byMaintainer.entries()]
    .filter(([, pkgs]) => pkgs.size > 0)
    .map(([maintainer, pkgs]) => ({
      maintainer,
      atRiskPackages: [...pkgs].sort(),
    }));

  return {
    found: true,
    downstream: downstreamList,
    lateralMovement: lateralList,
    totalAffected: affected.size,
  };
}

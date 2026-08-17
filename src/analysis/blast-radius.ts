import neo4j from "neo4j-driver";
import { runQuery } from "../db/connection.js";
import { QUERIES, downstreamBlastRadiusQuery } from "../db/queries.js";
import { nodeId } from "../db/node-id.js";

export interface BlastRadiusResult {
  downstream: Array<{ name: string }>;
  lateralMovement: Array<{ maintainer: string; atRiskPackages: string[] }>;
  totalAffected: number;
}

const int = neo4j.int;

/** Rows come back with names as strings; collect() columns come back as arrays. */
function asString(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}

export async function analyzeBlastRadius(
  packageName: string,
  maxDepth = 10,
): Promise<BlastRadiusResult> {
  const id = nodeId("package", packageName);

  const [downstream, lateral] = await Promise.all([
    runQuery<{ name: string }>(downstreamBlastRadiusQuery(maxDepth), {
      id: int(id),
    }),
    runQuery<{ maintainer: string; otherNames: string[] }>(
      QUERIES.sharedMaintainerRisk,
      { id: int(id) },
    ),
  ]);

  const affected = new Set<string>();

  // De-duplicate downstream packages reachable by multiple paths (HydraDB has
  // no DISTINCT aggregate, so this is done here).
  const downstreamSeen = new Set<string>();
  const downstreamList: Array<{ name: string }> = [];
  for (const row of downstream) {
    const name = asString(row.name);
    if (!name || downstreamSeen.has(name)) continue;
    downstreamSeen.add(name);
    affected.add(name);
    downstreamList.push({ name });
  }

  // Group maintainer overlap per maintainer, deduping their package lists.
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
    downstream: downstreamList,
    lateralMovement: lateralList,
    totalAffected: affected.size,
  };
}

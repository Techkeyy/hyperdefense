import { runQuery } from "../db/connection.js";
import { QUERIES } from "../db/queries.js";

export interface BlastRadiusResult {
  downstream: Array<{ package: string; depth: number }>;
  lateralMovement: Array<{
    maintainer: string;
    atRiskPackages: string[];
  }>;
  extendedBlast: Array<{
    package: string;
    entryPoint: string;
    depth: number;
  }>;
  totalAffected: number;
}

export async function analyzeBlastRadius(
  packageName: string,
): Promise<BlastRadiusResult> {
  const [downstream, lateral, extended] = await Promise.all([
    runQuery<{ package: string; depth: { low: number } }>(
      QUERIES.downstreamBlastRadius,
      { package: packageName },
    ),
    runQuery<{ maintainer: string; atRiskPackages: string[] }>(
      QUERIES.sharedMaintainerRisk,
      { package: packageName },
    ),
    runQuery<{
      package: string;
      entryPoint: string;
      depth: { low: number };
    }>(QUERIES.maintainerBlastRadius, { package: packageName }),
  ]);

  const allAffected = new Set<string>();
  const downstreamList = downstream.map((r) => {
    const name = r.package;
    const depth = typeof r.depth === "object" ? r.depth.low : Number(r.depth);
    allAffected.add(name);
    return { package: name, depth };
  });

  const lateralList = lateral.map((r) => {
    for (const p of r.atRiskPackages) allAffected.add(p);
    return {
      maintainer: r.maintainer,
      atRiskPackages: r.atRiskPackages,
    };
  });

  const extendedList = extended.map((r) => {
    const name = r.package;
    const depth = typeof r.depth === "object" ? r.depth.low : Number(r.depth);
    allAffected.add(name);
    return { package: name, entryPoint: r.entryPoint, depth };
  });

  return {
    downstream: downstreamList,
    lateralMovement: lateralList,
    extendedBlast: extendedList,
    totalAffected: allAffected.size,
  };
}

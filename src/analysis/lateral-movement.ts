import { runQuery } from "../db/connection.js";

export interface MaintainerRisk {
  maintainer: string;
  packages: string[];
  riskScore: number;
}

export async function analyzeLateralMovement(
  packageName: string,
): Promise<MaintainerRisk[]> {
  const results = await runQuery<{
    maintainer: string;
    packages: string[];
    packageCount: { low: number };
  }>(
    `
    MATCH (compromised:Package {name: $package})<-[:PUBLISHES]-(m:Maintainer)-[:PUBLISHES]->(other:Package)
    WHERE other.name <> $package
    WITH m, collect(DISTINCT other.name) AS packages, count(DISTINCT other) AS packageCount
    RETURN m.username AS maintainer,
           packages,
           packageCount
    ORDER BY packageCount DESC
    `,
    { package: packageName },
  );

  return results.map((r) => {
    const count =
      typeof r.packageCount === "object"
        ? r.packageCount.low
        : Number(r.packageCount);
    return {
      maintainer: r.maintainer,
      packages: r.packages,
      // More packages under one maintainer = higher worm propagation risk
      riskScore: Math.min(1.0, count / 20),
    };
  });
}

export async function findMaintainerOverlap(
  packages: string[],
): Promise<
  Array<{ maintainer: string; sharedPackages: string[]; overlapCount: number }>
> {
  const results = await runQuery<{
    maintainer: string;
    sharedPackages: string[];
    overlapCount: { low: number };
  }>(
    `
    UNWIND $packages AS pkgName
    MATCH (p:Package {name: pkgName})<-[:PUBLISHES]-(m:Maintainer)-[:PUBLISHES]->(other:Package)
    WHERE NOT other.name IN $packages
    WITH m, collect(DISTINCT other.name) AS sharedPackages, count(DISTINCT other) AS overlapCount
    WHERE overlapCount > 1
    RETURN m.username AS maintainer,
           sharedPackages,
           overlapCount
    ORDER BY overlapCount DESC
    `,
    { packages },
  );

  return results.map((r) => ({
    maintainer: r.maintainer,
    sharedPackages: r.sharedPackages,
    overlapCount:
      typeof r.overlapCount === "object"
        ? r.overlapCount.low
        : Number(r.overlapCount),
  }));
}

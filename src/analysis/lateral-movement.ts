import neo4j from "neo4j-driver";
import { runQuery } from "../db/connection.js";
import { QUERIES } from "../db/queries.js";
import { nodeId } from "../db/node-id.js";

export interface MaintainerRisk {
  maintainer: string;
  packages: string[];
  riskScore: number;
}

const int = neo4j.int;

function asString(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}

/**
 * Every other package published by a maintainer of the compromised package is
 * a lateral-movement candidate: a worm that compromises one maintainer account
 * can republish all of them. Risk scales with how many packages ride on one
 * account (a bigger blast if that account falls).
 */
export async function analyzeLateralMovement(
  packageName: string,
): Promise<MaintainerRisk[]> {
  const id = nodeId("package", packageName);

  const rows = await runQuery<{ maintainer: string; otherNames: string[] }>(
    QUERIES.sharedMaintainerRisk,
    { id: int(id) },
  );

  // Group + dedupe client-side (no DISTINCT aggregate in HydraDB).
  const byMaintainer = new Map<string, Set<string>>();
  for (const row of rows) {
    const maintainer = asString(row.maintainer);
    const names = Array.isArray(row.otherNames) ? row.otherNames : [];
    const set = byMaintainer.get(maintainer) ?? new Set<string>();
    for (const n of names) {
      const name = asString(n);
      if (name && name !== packageName) set.add(name);
    }
    byMaintainer.set(maintainer, set);
  }

  return [...byMaintainer.entries()]
    .filter(([, pkgs]) => pkgs.size > 0)
    .map(([maintainer, pkgs]) => ({
      maintainer,
      packages: [...pkgs].sort(),
      // More packages under one account => higher worm propagation risk.
      riskScore: Math.min(1, pkgs.size / 20),
    }))
    .sort((a, b) => b.packages.length - a.packages.length);
}

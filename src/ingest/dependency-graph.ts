import { runQuery } from "../db/connection.js";
import { QUERIES } from "../db/queries.js";
import { fetchPackage, type NpmPackageData } from "./npm-registry.js";

export async function ingestPackage(
  name: string,
  visited: Set<string>,
  maxDepth: number,
  currentDepth = 0,
): Promise<number> {
  if (visited.has(name) || currentDepth > maxDepth) return 0;
  visited.add(name);

  let pkg: NpmPackageData;
  try {
    pkg = await fetchPackage(name);
  } catch {
    return 0;
  }

  const latestTag = pkg["dist-tags"]?.latest;
  const latestVersion = latestTag ? pkg.versions?.[latestTag] : undefined;

  await runQuery(QUERIES.upsertPackage, {
    name: pkg.name,
    description: pkg.description ?? "",
    latestVersion: latestTag ?? "",
  });

  // Ingest maintainers
  if (pkg.maintainers) {
    for (const m of pkg.maintainers) {
      await runQuery(QUERIES.upsertMaintainer, {
        username: m.name,
        email: m.email ?? "",
      });
      await runQuery(QUERIES.linkMaintainerToPackage, {
        username: m.name,
        package: pkg.name,
      });
    }
  }

  // Ingest versions with timestamps
  if (pkg.time && latestTag) {
    const publishedAt = pkg.time[latestTag] ?? "";
    const versionId = `${pkg.name}@${latestTag}`;
    await runQuery(QUERIES.upsertVersion, {
      id: versionId,
      package: pkg.name,
      version: latestTag,
      publishedAt,
    });
  }

  let count = 1;

  const deps = latestVersion?.dependencies ?? {};
  for (const [depName, versionRange] of Object.entries(deps)) {
    // Create the dependency package node first (so the edge can be created)
    await runQuery(QUERIES.upsertPackage, {
      name: depName,
      description: "",
      latestVersion: "",
    });

    await runQuery(QUERIES.createDependency, {
      from: pkg.name,
      to: depName,
      versionRange,
    });

    count += await ingestPackage(depName, visited, maxDepth, currentDepth + 1);
  }

  return count;
}

/**
 * HydraDB's executable Cypher subset does not include `CREATE CONSTRAINT`
 * (see docs/HYDRADB-CYPHER-SPEC.md), and HyperDefense does not need one:
 * node identity is a deterministic integer id and every write is a MERGE by
 * that id, so idempotency is structural rather than enforced by a constraint.
 *
 * This is kept as a named step so the ingest flow has an obvious place to add
 * schema setup if HydraDB gains constraint or index DDL later.
 */
export async function initSchema(): Promise<void> {
  // Intentionally empty. See the note above.
}

/**
 * Clear the graph and the id map together.
 *
 * Both, always: node identity is a compact integer assigned by the registry, so
 * dropping the map while leaving the nodes would hand out ids that collide with
 * rows already in the graph, and the next ingest would silently merge unrelated
 * packages onto each other.
 *
 * Exists mainly so a demo run produces identical numbers regardless of what ran
 * before it, which matters when the run is being recorded.
 */
export async function resetGraph(registryPath: string): Promise<void> {
  const { runQuery } = await import("./connection.js");
  const { rm } = await import("node:fs/promises");

  // Anchored by label: a bare MATCH (n) is rejected by HydraDB.
  for (const label of ["Package", "Maintainer", "Version"]) {
    try {
      await runQuery(`MATCH (n:${label}) DETACH DELETE n`);
    } catch {
      try {
        await runQuery(`MATCH (n:${label}) DELETE n`);
      } catch {
        // Leave what cannot be removed rather than aborting the run.
      }
    }
  }

  await rm(registryPath, { force: true });
}

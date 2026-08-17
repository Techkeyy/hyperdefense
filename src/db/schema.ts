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

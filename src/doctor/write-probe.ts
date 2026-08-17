import neo4j from "neo4j-driver";
import { runQuery } from "../db/connection.js";

const int = neo4j.int;

export interface WriteProbeResult {
  step: string;
  query: string;
  ok: boolean;
  code?: string;
  message?: string;
}

/**
 * Runs each write form HyperDefense depends on, one at a time with a single
 * minimal row, and reports the full error per step. The ingest flush fires six
 * UNWIND queries in a row and collapses any failure into one generic message;
 * this isolates exactly which shape HydraDB rejects and surfaces its real
 * error code instead of the wrapper.
 */
export async function runWriteProbe(): Promise<WriteProbeResult[]> {
  const results: WriteProbeResult[] = [];

  // Small integer ids. HydraDB uses the vertex id as a GraphBLAS matrix index,
  // so ids must be compact; a large id makes the write fail with an internal
  // execution error. These tiny values both stay clear of real data (real ids
  // start at 1 and climb, but this graph is disposable) and confirm that
  // compact ids are the fix.
  const A = int(9001);
  const B = int(9002);
  const V = int(9003);
  const E = int(9004);

  const steps: Array<{ step: string; query: string; params: Record<string, unknown> }> = [
    {
      step: "1. vertex upsert (single row, one label + props)",
      query:
        "UNWIND $rows AS row MERGE (n {id: row.id}) SET n:Package, n.name = row.name",
      params: { rows: [{ id: A, name: "__probe_pkg_a" }] },
    },
    {
      step: "2. vertex upsert (second node, for the edge)",
      query:
        "UNWIND $rows AS row MERGE (n {id: row.id}) SET n:Package, n.name = row.name",
      params: { rows: [{ id: B, name: "__probe_pkg_b" }] },
    },
    {
      step: "3. vertex upsert with empty-string property",
      query:
        "UNWIND $rows AS row MERGE (n {id: row.id}) SET n:Package, n.name = row.name, n.description = row.description",
      params: { rows: [{ id: A, name: "__probe_pkg_a", description: "" }] },
    },
    {
      step: "4. maintainer node",
      query:
        "UNWIND $rows AS row MERGE (n {id: row.id}) SET n:Maintainer, n.username = row.username",
      params: { rows: [{ id: V, username: "__probe_maint" }] },
    },
    {
      step: "5. edge: MATCH label+id both ends, MERGE rel with id",
      query:
        "UNWIND $rows AS row MATCH (s:Package {id: row.src}), (d:Package {id: row.dst}) MERGE (s)-[:DEPENDS_ON {id: row.eid}]->(d)",
      params: { rows: [{ src: A, dst: B, eid: E }] },
    },
    {
      step: "6. edge: cross-label (Maintainer -> Package)",
      query:
        "UNWIND $rows AS row MATCH (s:Maintainer {id: row.src}), (d:Package {id: row.dst}) MERGE (s)-[:PUBLISHES {id: row.eid}]->(d)",
      params: { rows: [{ src: V, dst: A, eid: int(900000005) }] },
    },
    {
      step: "7. read back: MATCH by id, project property",
      query: "MATCH (n:Package {id: $id}) RETURN n.name AS name",
      params: { id: A },
    },
    {
      step: "8. traversal: reverse var-length *1..2 (literal source id)",
      // Variable-length MATCH requires a fixed (literal) source id, not a param.
      query:
        "MATCH (c {id: 9002})<-[:DEPENDS_ON*1..2]-(x:Package) RETURN x.id AS id, x.name AS name",
      params: {},
    },
    {
      step: "9. two-hop maintainer pattern with collect()",
      query:
        "MATCH (c {id: $id})<-[:PUBLISHES]-(m:Maintainer)-[:PUBLISHES]->(other:Package) RETURN m.username AS maintainer, collect(other.name) AS names",
      params: { id: A },
    },
  ];

  for (const s of steps) {
    try {
      await runQuery(s.query, s.params);
      results.push({ step: s.step, query: s.query, ok: true });
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string };
      results.push({
        step: s.step,
        query: s.query,
        ok: false,
        code: e.code,
        message: e.message,
      });
    }
  }

  // Best-effort cleanup of probe nodes.
  for (const id of [A, B, V]) {
    try {
      await runQuery("MATCH (n {id: $id}) DETACH DELETE n", { id });
    } catch {
      // ignore
    }
  }

  return results;
}

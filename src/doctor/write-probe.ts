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
      step: "8a. var-length INBOUND (expected to fail: source must hold the id)",
      query:
        "MATCH (c {id: 9002})<-[:DEPENDS_ON*1..2]-(x:Package) RETURN x.id AS id, x.name AS name",
      params: {},
    },
    {
      step: "8b. reverse edge write (DEPENDED_ON_BY)",
      query:
        "UNWIND $rows AS row MATCH (s:Package {id: row.src}), (d:Package {id: row.dst}) MERGE (s)-[:DEPENDED_ON_BY {id: row.eid}]->(d)",
      params: { rows: [{ src: B, dst: A, eid: int(9006) }] },
    },
    {
      step: "8c. var-length OUTBOUND on reverse edge (the blast-radius shape)",
      query:
        "MATCH (c {id: 9002})-[:DEPENDED_ON_BY*1..2]->(x:Package) RETURN x.id AS id, x.name AS name",
      params: {},
    },
    // --- Native path procedures, CORRECT form this time -------------------
    // The first probe used `MATCH ... CALL`, which fails is_native_path_procedure
    // and falls through to a clause walker that does not allow CALL. The
    // statement must START with `CALL algo.`, which short-circuits straight to
    // the procedure engine. Source: query/opencypher.rs
    // classify_opencypher_query_access + query/path_procedure.rs
    // is_native_path_procedure. Shape taken from HydraDB's own Bolt test
    // bolt_server_runs_native_path_procedure_calls.
    {
      step: "9a. algo.SSpaths, CALL-first, sourceNode by id",
      query:
        "CALL algo.SSpaths({sourceNode: 9001, relTypes: ['DEPENDS_ON'], maxLen: 3}) YIELD path RETURN path",
      params: {},
    },
    {
      step: "9b. algo.SPpaths, CALL-first, source + target by id",
      query:
        "CALL algo.SPpaths({sourceNode: 9001, targetNode: 9002, relTypes: ['DEPENDS_ON'], maxLen: 3}) YIELD path RETURN path",
      params: {},
    },
    {
      step: "9c. algo.MSpaths, indexed label/property selectors (the many-at-once primitive)",
      query:
        "CALL algo.MSpaths({sourceLabel: 'Package', sourceProperty: 'name', " +
        "sourceValues: ['__probe_pkg_a'], relTypes: ['DEPENDS_ON'], " +
        "maxLen: 3, relDirection: 'outgoing', resultLimit: 100}) YIELD path RETURN path",
      params: {},
    },
    {
      step: "9d. algo.MSpaths over the reverse edge (the real blast-radius query)",
      query:
        "CALL algo.MSpaths({sourceLabel: 'Package', sourceProperty: 'name', " +
        "sourceValues: ['__probe_pkg_b'], relTypes: ['DEPENDED_ON_BY'], " +
        "maxLen: 5, relDirection: 'outgoing', resultLimit: 100}) YIELD path RETURN path",
      params: {},
    },
    {
      step: "10. two-hop maintainer pattern with collect()",
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

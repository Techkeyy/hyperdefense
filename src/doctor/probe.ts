import type { Driver } from "neo4j-driver";
import {
  AUTH_STRATEGIES,
  URI_SCHEMES,
  buildDriver,
  getConfig,
  probeConnection,
} from "../db/connection.js";

export interface ConnectionResult {
  uri: string;
  scheme: string;
  auth: string;
  error?: string;
}

export interface ProbeResult {
  id: string;
  label: string;
  /** Why the build cares. Shown in the report so the matrix is self-explaining. */
  matters: string;
  status: "supported" | "unsupported" | "wrong-result";
  detail?: string;
}

/** neo4j-driver returns 64-bit ints as {low, high} objects. */
function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && "low" in v) {
    return Number((v as { low: number }).low);
  }
  return Number(v);
}

const PROBE_LABEL = "__HDProbe";
const PROBE_REL = "__HD_LINKS";

/**
 * Walk every uri scheme against every auth strategy until one round-trips a
 * trivial statement. Nothing about HydraDB's Bolt auth is documented, so this
 * is discovered rather than guessed.
 */
export async function findWorkingConnection(): Promise<
  { ok: true; result: ConnectionResult } | { ok: false; attempts: ConnectionResult[] }
> {
  const config = getConfig();
  const host = config.uri.replace(/^[a-z+]+:\/\//, "");
  const attempts: ConnectionResult[] = [];

  for (const scheme of URI_SCHEMES) {
    const uri = `${scheme}://${host}`;
    for (const strategy of AUTH_STRATEGIES) {
      const res = await probeConnection(uri, strategy.build(config.token));
      if (res.ok) {
        return { ok: true, result: { uri, scheme, auth: strategy.name } };
      }
      attempts.push({ uri, scheme, auth: strategy.name, error: res.error });
    }
  }
  return { ok: false, attempts };
}

interface ProbeSpec {
  id: string;
  label: string;
  matters: string;
  run: (driver: Driver) => Promise<{ ok: boolean; detail?: string }>;
}

async function one(
  driver: Driver,
  cypher: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>[]> {
  const session = driver.session();
  try {
    const r = await session.run(cypher, params);
    return r.records.map((x) => x.toObject());
  } finally {
    await session.close();
  }
}

const SPECS: ProbeSpec[] = [
  {
    id: "return-literal",
    label: "RETURN literal",
    matters: "baseline, proves the session executes statements at all",
    run: async (d) => {
      const r = await one(d, "RETURN 1 AS ok");
      return { ok: toNum(r[0]?.ok) === 1 };
    },
  },
  {
    id: "create-node",
    label: "CREATE node with label and property",
    matters: "ingestion writes every package as a labelled node",
    run: async (d) => {
      await one(d, `CREATE (n:${PROBE_LABEL} {k: $k}) RETURN n`, { k: "seed" });
      const r = await one(
        d,
        `MATCH (n:${PROBE_LABEL} {k: $k}) RETURN count(n) AS c`,
        { k: "seed" },
      );
      return { ok: toNum(r[0]?.c) >= 1 };
    },
  },
  {
    id: "merge-idempotent",
    label: "MERGE is idempotent",
    matters:
      "ingestion re-visits shared dependencies constantly; without MERGE the graph fills with duplicates",
    run: async (d) => {
      await one(d, `MERGE (n:${PROBE_LABEL} {k: $k}) RETURN n`, { k: "merge" });
      await one(d, `MERGE (n:${PROBE_LABEL} {k: $k}) RETURN n`, { k: "merge" });
      const r = await one(
        d,
        `MATCH (n:${PROBE_LABEL} {k: $k}) RETURN count(n) AS c`,
        { k: "merge" },
      );
      const c = toNum(r[0]?.c);
      return { ok: c === 1, detail: c === 1 ? undefined : `produced ${c} nodes` };
    },
  },
  {
    id: "typed-rel",
    label: "typed relationship, single hop",
    matters: "DEPENDS_ON and PUBLISHES are typed edges",
    run: async (d) => {
      await one(
        d,
        `MERGE (a:${PROBE_LABEL} {k:'c0'})
         MERGE (b:${PROBE_LABEL} {k:'c1'})
         MERGE (a)-[:${PROBE_REL}]->(b)`,
      );
      const r = await one(
        d,
        `MATCH (:${PROBE_LABEL} {k:'c0'})-[:${PROBE_REL}]->(b) RETURN count(b) AS c`,
      );
      return { ok: toNum(r[0]?.c) === 1 };
    },
  },
  {
    id: "varlen-fixed",
    label: "fixed-depth traversal -[:R*2]->",
    matters: "the simplest multi-hop form; if this fails nothing traverses",
    run: async (d) => {
      const r = await one(
        d,
        `MATCH (:${PROBE_LABEL} {k:'c0'})-[:${PROBE_REL}*2]->(n) RETURN count(n) AS c`,
      );
      return { ok: toNum(r[0]?.c) >= 1 };
    },
  },
  {
    id: "varlen-range-5",
    label: "bounded variable-length -[:R*1..5]->",
    matters: "transitive dependency closure, the core blast radius query",
    run: async (d) => {
      const r = await one(
        d,
        `MATCH (:${PROBE_LABEL} {k:'c0'})-[:${PROBE_REL}*1..5]->(n) RETURN count(DISTINCT n) AS c`,
      );
      return { ok: toNum(r[0]?.c) >= 1 };
    },
  },
  {
    id: "varlen-range-10",
    label: "bounded variable-length -[:R*1..10]->",
    matters:
      "current queries assume depth 10; real npm chains run deep and a low ceiling silently truncates the answer",
    run: async (d) => {
      const r = await one(
        d,
        `MATCH (:${PROBE_LABEL} {k:'c0'})-[:${PROBE_REL}*1..10]->(n) RETURN count(DISTINCT n) AS c`,
      );
      return { ok: toNum(r[0]?.c) >= 1 };
    },
  },
  {
    id: "reverse-traversal",
    label: "reverse variable-length <-[:R*1..5]-",
    matters:
      "blast radius runs UPSTREAM from the compromised package; direction must work both ways",
    run: async (d) => {
      const r = await one(
        d,
        `MATCH (:${PROBE_LABEL} {k:'c4'})<-[:${PROBE_REL}*1..5]-(n) RETURN count(DISTINCT n) AS c`,
      );
      return { ok: toNum(r[0]?.c) >= 1 };
    },
  },
  {
    id: "named-path-length",
    label: "named path with length()",
    matters: "depth is reported per affected package in the CLI output",
    run: async (d) => {
      const r = await one(
        d,
        `MATCH p = (:${PROBE_LABEL} {k:'c0'})-[:${PROBE_REL}*1..5]->(n)
         RETURN max(length(p)) AS d`,
      );
      return { ok: toNum(r[0]?.d) >= 1 };
    },
  },
  {
    id: "collect-distinct",
    label: "collect(DISTINCT x)",
    matters: "maintainer overlap groups package lists per maintainer",
    run: async (d) => {
      const r = await one(
        d,
        `MATCH (n:${PROBE_LABEL}) RETURN collect(DISTINCT n.k) AS ks`,
      );
      return { ok: Array.isArray(r[0]?.ks) };
    },
  },
  {
    id: "unwind-param",
    label: "UNWIND $list",
    matters: "batched writes and multi-source queries both depend on it",
    run: async (d) => {
      const r = await one(d, `UNWIND $xs AS x RETURN count(x) AS c`, {
        xs: ["a", "b", "c"],
      });
      return { ok: toNum(r[0]?.c) === 3 };
    },
  },
  {
    id: "where-in-list",
    label: "WHERE x IN $list",
    matters: "maintainer overlap excludes the already-known compromised set",
    run: async (d) => {
      const r = await one(
        d,
        `MATCH (n:${PROBE_LABEL}) WHERE n.k IN $ks RETURN count(n) AS c`,
        { ks: ["c0", "c1"] },
      );
      return { ok: toNum(r[0]?.c) === 2 };
    },
  },
  {
    id: "optional-match",
    label: "OPTIONAL MATCH",
    matters: "packages with no maintainer data must not vanish from results",
    run: async (d) => {
      const r = await one(
        d,
        `MATCH (n:${PROBE_LABEL} {k:'c0'})
         OPTIONAL MATCH (n)-[:__NOPE]->(m)
         RETURN count(n) AS c`,
      );
      return { ok: toNum(r[0]?.c) >= 1 };
    },
  },
  {
    id: "algo-sppaths",
    label: "algo.SPpaths procedure",
    matters: "native single source-target paths, avoids client fan-out",
    run: async (d) => {
      const r = await one(
        d,
        `MATCH (a:${PROBE_LABEL} {k:'c0'}), (b:${PROBE_LABEL} {k:'c2'})
         CALL algo.SPpaths({sourceNode: a, targetNode: b, relTypes: ['${PROBE_REL}']})
         YIELD path RETURN count(path) AS c`,
      );
      return { ok: true, detail: `returned ${toNum(r[0]?.c)} paths` };
    },
  },
  {
    id: "algo-sspaths",
    label: "algo.SSpaths procedure",
    matters: "native bounded paths from one source, the blast radius primitive",
    run: async (d) => {
      const r = await one(
        d,
        `MATCH (a:${PROBE_LABEL} {k:'c0'})
         CALL algo.SSpaths({sourceNode: a, relTypes: ['${PROBE_REL}'], maxLen: 5})
         YIELD path RETURN count(path) AS c`,
      );
      return { ok: true, detail: `returned ${toNum(r[0]?.c)} paths` };
    },
  },
  {
    id: "algo-mspaths",
    label: "algo.MSpaths procedure",
    matters:
      "resolves many source-target pairs in one call; the right primitive for 42 compromised packages at once and the strongest HydraDB-native story",
    run: async (d) => {
      const r = await one(
        d,
        `MATCH (a:${PROBE_LABEL} {k:'c0'}), (b:${PROBE_LABEL} {k:'c3'})
         CALL algo.MSpaths({sourceNodes: [a], targetNodes: [b], relTypes: ['${PROBE_REL}'], maxLen: 5})
         YIELD path RETURN count(path) AS c`,
      );
      return { ok: true, detail: `returned ${toNum(r[0]?.c)} paths` };
    },
  },
];

/** Build a 5-node chain c0->c1->c2->c3->c4 for the traversal probes. */
async function seedChain(driver: Driver): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await one(driver, `MERGE (n:${PROBE_LABEL} {k: $k}) RETURN n`, {
      k: `c${i}`,
    });
  }
  for (let i = 0; i < 4; i++) {
    await one(
      driver,
      `MATCH (a:${PROBE_LABEL} {k: $a}), (b:${PROBE_LABEL} {k: $b})
       MERGE (a)-[:${PROBE_REL}]->(b)`,
      { a: `c${i}`, b: `c${i + 1}` },
    );
  }
}

export async function cleanup(driver: Driver): Promise<void> {
  try {
    await one(driver, `MATCH (n:${PROBE_LABEL}) DETACH DELETE n`);
  } catch {
    try {
      await one(driver, `MATCH (n:${PROBE_LABEL}) DELETE n`);
    } catch {
      // leave probe nodes rather than fail the run
    }
  }
}

export async function runProbes(
  connection: ConnectionResult,
  token: string,
): Promise<ProbeResult[]> {
  const strategy = AUTH_STRATEGIES.find((s) => s.name === connection.auth);
  const driver = buildDriver(
    connection.uri,
    (strategy ?? AUTH_STRATEGIES[0]).build(token),
  );

  const results: ProbeResult[] = [];
  try {
    try {
      await seedChain(driver);
    } catch {
      // seeding may fail if writes are unsupported; probes report that
    }

    for (const spec of SPECS) {
      try {
        const r = await spec.run(driver);
        results.push({
          id: spec.id,
          label: spec.label,
          matters: spec.matters,
          status: r.ok ? "supported" : "wrong-result",
          detail: r.detail,
        });
      } catch (err) {
        results.push({
          id: spec.id,
          label: spec.label,
          matters: spec.matters,
          status: "unsupported",
          detail: err instanceof Error ? err.message.split("\n")[0] : String(err),
        });
      }
    }

    await cleanup(driver);
  } finally {
    await driver.close().catch(() => {});
  }
  return results;
}

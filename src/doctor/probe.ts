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

/**
 * Every RETURN in these probes is restricted to `<binding>.<property>` or
 * `count(*)`. HydraDB rejects `RETURN n` outright ("RETURN currently supports
 * <binding>.<property> or count(*)"), so anything more expressive is treated
 * as its own capability question with a dedicated row, rather than smuggled
 * into unrelated probes.
 */
const SPECS: ProbeSpec[] = [
  {
    id: "match-count-star",
    label: "MATCH ... RETURN count(*)",
    matters: "baseline read; the only projection form the server documents",
    run: async (d) => {
      const r = await one(d, `MATCH (n) RETURN count(*) AS c`);
      return { ok: typeof toNum(r[0]?.c) === "number" };
    },
  },
  {
    id: "return-literal",
    label: "RETURN 1 (scalar without MATCH)",
    matters:
      "measured because assuming it works cost the first doctor run; if unsupported, no query in the codebase may compute a scalar without touching the graph",
    run: async (d) => {
      const r = await one(d, "RETURN 1 AS ok");
      return { ok: toNum(r[0]?.ok) === 1 };
    },
  },
  {
    id: "return-property",
    label: "RETURN n.prop",
    matters:
      "the primary read shape for the whole app: dependents, maintainers, versions, all need to project properties",
    run: async (d) => {
      const r = await one(
        d,
        `MATCH (n:${PROBE_LABEL}) RETURN n.k AS k LIMIT 1`,
      );
      return { ok: typeof r[0]?.k === "string" };
    },
  },
  {
    id: "return-node",
    label: "RETURN n (whole node)",
    matters:
      "confirmed unsupported by the second doctor run; probed anyway so the matrix records it explicitly",
    run: async (d) => {
      await one(d, `MATCH (n:${PROBE_LABEL}) RETURN n LIMIT 1`);
      return { ok: true };
    },
  },
  {
    id: "count-binding",
    label: "count(n) (function on a binding)",
    matters:
      "count(*) is documented; count(n) is not. If unsupported the ingest verification and every blast radius aggregate must switch to count(*)",
    run: async (d) => {
      const r = await one(
        d,
        `MATCH (n:${PROBE_LABEL}) RETURN count(n) AS c`,
      );
      return { ok: toNum(r[0]?.c) >= 1 };
    },
  },
  {
    id: "count-distinct",
    label: "count(DISTINCT n)",
    matters:
      "blast radius de-duplicates affected packages; without it a package reachable by two paths counts twice",
    run: async (d) => {
      const r = await one(
        d,
        `MATCH (n:${PROBE_LABEL}) RETURN count(DISTINCT n) AS c`,
      );
      return { ok: toNum(r[0]?.c) >= 1 };
    },
  },
  {
    id: "collect-property",
    label: "collect(n.k)",
    matters:
      "maintainer overlap groups package lists per maintainer; without it the output is one row per (maintainer, package) pair and de-duplication moves to the client",
    run: async (d) => {
      const r = await one(
        d,
        `MATCH (n:${PROBE_LABEL}) RETURN collect(n.k) AS ks`,
      );
      return { ok: Array.isArray(r[0]?.ks) };
    },
  },
  {
    id: "collect-distinct",
    label: "collect(DISTINCT n.k)",
    matters: "same as collect, deduplicated",
    run: async (d) => {
      const r = await one(
        d,
        `MATCH (n:${PROBE_LABEL}) RETURN collect(DISTINCT n.k) AS ks`,
      );
      return { ok: Array.isArray(r[0]?.ks) };
    },
  },
  {
    id: "create-node",
    label: "CREATE node with label and property",
    matters: "ingestion writes every package as a labelled node",
    run: async (d) => {
      await one(d, `CREATE (n:${PROBE_LABEL} {k: $k})`, { k: "seed-a" });
      const r = await one(
        d,
        `MATCH (n:${PROBE_LABEL} {k: $k}) RETURN count(*) AS c`,
        { k: "seed-a" },
      );
      return { ok: toNum(r[0]?.c) >= 1 };
    },
  },
  {
    id: "merge-idempotent",
    label: "MERGE is idempotent",
    matters:
      "ingestion re-visits shared dependencies constantly; without MERGE the graph fills with duplicates and every subsequent count is wrong",
    run: async (d) => {
      await one(d, `MERGE (n:${PROBE_LABEL} {k: $k})`, { k: "seed-b" });
      await one(d, `MERGE (n:${PROBE_LABEL} {k: $k})`, { k: "seed-b" });
      const r = await one(
        d,
        `MATCH (n:${PROBE_LABEL} {k: $k}) RETURN count(*) AS c`,
        { k: "seed-b" },
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
      const r = await one(
        d,
        `MATCH (:${PROBE_LABEL} {k:'c0'})-[:${PROBE_REL}]->(b) RETURN count(*) AS c`,
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
        `MATCH (:${PROBE_LABEL} {k:'c0'})-[:${PROBE_REL}*2]->(n) RETURN count(*) AS c`,
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
        `MATCH (:${PROBE_LABEL} {k:'c0'})-[:${PROBE_REL}*1..5]->(n) RETURN count(*) AS c`,
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
        `MATCH (:${PROBE_LABEL} {k:'c0'})-[:${PROBE_REL}*1..10]->(n) RETURN count(*) AS c`,
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
        `MATCH (:${PROBE_LABEL} {k:'c4'})<-[:${PROBE_REL}*1..5]-(n) RETURN count(*) AS c`,
      );
      return { ok: toNum(r[0]?.c) >= 1 };
    },
  },
  {
    id: "named-path-length",
    label: "named path with length()",
    matters:
      "depth is reported per affected package in the CLI output; without it the report can still exist, just without the per-row depth",
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
    id: "unwind-param",
    label: "UNWIND $list",
    matters: "batched writes and multi-source queries both depend on it",
    run: async (d) => {
      const r = await one(d, `UNWIND $xs AS x RETURN count(*) AS c`, {
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
        `MATCH (n:${PROBE_LABEL}) WHERE n.k IN $ks RETURN count(*) AS c`,
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
         RETURN count(*) AS c`,
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
         YIELD path RETURN count(*) AS c`,
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
         YIELD path RETURN count(*) AS c`,
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
         YIELD path RETURN count(*) AS c`,
      );
      return { ok: true, detail: `returned ${toNum(r[0]?.c)} paths` };
    },
  },
];

/** Build a 5-node chain c0->c1->c2->c3->c4 for the traversal probes. */
async function seedChain(driver: Driver): Promise<void> {
  for (let i = 0; i < 5; i++) {
    // Pure mutation, no RETURN. See create-node for why.
    await one(driver, `MERGE (n:${PROBE_LABEL} {k: $k})`, {
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

/** CREATE-only fallback for a server that rejects MERGE. */
async function seedChainFallback(driver: Driver): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await one(driver, `CREATE (n:${PROBE_LABEL} {k: $k})`, { k: `c${i}` });
  }
  for (let i = 0; i < 4; i++) {
    await one(
      driver,
      `MATCH (a:${PROBE_LABEL} {k: $a}), (b:${PROBE_LABEL} {k: $b})
       CREATE (a)-[:${PROBE_REL}]->(b)`,
      { a: `c${i}`, b: `c${i + 1}` },
    );
  }
}

/**
 * Confirms the probe fixture actually exists. Without this a seeding failure
 * makes every traversal probe report "unsupported" for the wrong reason, which
 * would send the whole query-layer redesign down a false path.
 */
async function verifySeed(driver: Driver): Promise<boolean> {
  try {
    // count(*) rather than count(n): count(*) is the documented projection
    // form, and if count(n) turns out to be unsupported the seed verifier
    // must not itself be the thing that fails.
    const r = await one(
      driver,
      `MATCH (n:${PROBE_LABEL}) RETURN count(*) AS c`,
    );
    return toNum(r[0]?.c) >= 5;
  } catch {
    return false;
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
    await cleanup(driver);
    try {
      await seedChain(driver);
    } catch {
      try {
        await cleanup(driver);
        await seedChainFallback(driver);
      } catch {
        // both write paths failed; verifySeed below reports it
      }
    }

    const seeded = await verifySeed(driver);
    if (!seeded) {
      results.push({
        id: "probe-fixture",
        label: "probe fixture seeded",
        matters:
          "traversal probes are meaningless without it; treat every traversal row below as inconclusive rather than unsupported",
        status: "wrong-result",
        detail: "could not build the 5-node probe chain with MERGE or CREATE",
      });
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

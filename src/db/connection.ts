import neo4j, { type Driver, type Session, type AuthToken } from "neo4j-driver";

export interface HydraConfig {
  uri: string;
  token: string;
  database?: string;
}

const DEFAULT_URI = "bolt://127.0.0.1:7687";
const DEFAULT_TOKEN = "local-development-token-32-bytes";

let driver: Driver | null = null;

export function getConfig(): HydraConfig {
  return {
    uri: process.env.HYDRA_URI ?? DEFAULT_URI,
    token: process.env.HYDRA_TOKEN ?? DEFAULT_TOKEN,
    database: process.env.HYDRA_DATABASE ?? "default",
  };
}

/**
 * Auth schemes to try, in order. HydraDB documents `Authorization: Bearer` for
 * its HTTP API but does not state the Bolt equivalent, so the working scheme is
 * discovered rather than assumed. `doctor` reports which one succeeded.
 */
export const AUTH_STRATEGIES: Array<{
  name: string;
  build: (token: string) => AuthToken;
}> = [
  { name: "bearer", build: (t) => neo4j.auth.bearer(t) },
  { name: "basic(neo4j,token)", build: (t) => neo4j.auth.basic("neo4j", t) },
  { name: "basic(empty,token)", build: (t) => neo4j.auth.basic("", t) },
  // The driver exposes no `auth.none()`; the no-auth token is the custom
  // scheme "none" with empty credentials.
  { name: "none", build: () => neo4j.auth.custom("", "", "", "none") },
];

/**
 * Direct (`bolt://`) is tried before routed (`neo4j://`). A routed uri makes the
 * client reconnect to whatever address the server advertises, which is wrong
 * whenever that address is not reachable from the client's network namespace.
 */
export const URI_SCHEMES = ["bolt", "neo4j"] as const;

export function buildDriver(uri: string, auth: AuthToken): Driver {
  return neo4j.driver(uri, auth, {
    connectionAcquisitionTimeout: 10_000,
    connectionTimeout: 10_000,
    maxTransactionRetryTime: 5_000,
  });
}

/** Open a driver and run a trivial statement. Returns null on any failure. */
export async function probeConnection(
  uri: string,
  auth: AuthToken,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let d: Driver | null = null;
  try {
    d = buildDriver(uri, auth);
    const session = d.session();
    try {
      // HydraDB requires three things a normal Cypher probe would omit:
      //   1. RETURN can only project <binding>.<property> or count(*)
      //   2. MATCH must anchor with an id, label, or property predicate;
      //      bare `MATCH (n)` is rejected as "node-only MATCH requires ..."
      //   3. `RETURN 1` without MATCH is rejected outright
      // A labelled MATCH satisfies all three, matches zero rows on an unknown
      // label (rather than erroring), and confirms the socket, auth, and
      // query planner all round-trip. This shape mirrors HydraDB's own
      // examples/query_correctness.rs test suite.
      await session.run("MATCH (n:__HDConnCheck) RETURN count(*) AS c");
      return { ok: true };
    } finally {
      await session.close();
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (d) await d.close().catch(() => {});
  }
}

export function getDriver(): Driver {
  if (driver) return driver;
  const config = getConfig();
  const strategy = process.env.HYDRA_AUTH ?? "bearer";
  const found = AUTH_STRATEGIES.find((s) => s.name.startsWith(strategy));
  const auth = (found ?? AUTH_STRATEGIES[0]).build(config.token);
  driver = buildDriver(config.uri, auth);
  return driver;
}

export function getSession(): Session {
  return getDriver().session();
}

export async function runQuery<T = Record<string, unknown>>(
  cypher: string,
  params: Record<string, unknown> = {},
): Promise<T[]> {
  const session = getSession();
  try {
    const result = await session.run(cypher, params);
    return result.records.map((r) => r.toObject() as T);
  } finally {
    await session.close();
  }
}

export async function closeConnection(): Promise<void> {
  if (driver) {
    await driver.close();
    driver = null;
  }
}

import neo4j, { Driver, Session, type AuthToken } from "neo4j-driver";

export interface HydraConfig {
  uri: string;
  token: string;
  database?: string;
}

const DEFAULT_CONFIG: HydraConfig = {
  uri: "neo4j://127.0.0.1:7687",
  token: "local-development-token-32-bytes",
  database: "default",
};

let driver: Driver | null = null;

export function getConfig(): HydraConfig {
  return {
    uri: process.env.HYDRA_URI ?? DEFAULT_CONFIG.uri,
    token: process.env.HYDRA_TOKEN ?? DEFAULT_CONFIG.token,
    database: process.env.HYDRA_DATABASE ?? DEFAULT_CONFIG.database,
  };
}

export function getDriver(): Driver {
  if (driver) return driver;
  const config = getConfig();
  driver = neo4j.driver(
    config.uri,
    neo4j.auth.bearer(config.token),
  );
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

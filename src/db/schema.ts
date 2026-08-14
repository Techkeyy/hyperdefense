import { runQuery } from "./connection.js";

export async function initSchema(): Promise<void> {
  const constraints = [
    `CREATE CONSTRAINT IF NOT EXISTS FOR (p:Package) REQUIRE p.name IS UNIQUE`,
    `CREATE CONSTRAINT IF NOT EXISTS FOR (v:Version) REQUIRE v.id IS UNIQUE`,
    `CREATE CONSTRAINT IF NOT EXISTS FOR (m:Maintainer) REQUIRE m.username IS UNIQUE`,
    `CREATE CONSTRAINT IF NOT EXISTS FOR (o:Org) REQUIRE o.name IS UNIQUE`,
  ];

  for (const c of constraints) {
    try {
      await runQuery(c);
    } catch {
      // HydraDB may not support all constraint syntax; continue
    }
  }
}

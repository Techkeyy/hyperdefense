/**
 * Advisory feed: closes the loop from "an advisory was published" to "here is
 * the blast radius in your graph".
 *
 * Without this, HyperDefense only answers questions someone already knew to
 * ask. A responder still has to notice an advisory, recognise the package, and
 * come here. This watches the packages already in the graph and tells you which
 * ones just became interesting.
 *
 * Uses OSV (https://osv.dev), the open vulnerability database that aggregates
 * GHSA and other sources. Public, no auth, and it has a batch endpoint, which
 * matters because the graph holds thousands of packages.
 *
 * Shapes below were verified against live calls, not assumed:
 *   POST /v1/querybatch {queries:[{package:{name,ecosystem}}]}
 *     -> {results:[{vulns?:[{id,modified}]}]}   POSITIONAL, aligns to queries
 *   POST /v1/query      {package:{name,ecosystem}}
 *     -> {vulns:[{id,summary,details,affected,...}]}
 * The batch endpoint returns ids only, so details are fetched per package and
 * only for the ones that matter.
 */

const OSV_BATCH = "https://api.osv.dev/v1/querybatch";
const OSV_QUERY = "https://api.osv.dev/v1/query";

export interface AdvisorySummary {
  packageName: string;
  /** Advisory ids, e.g. GHSA-xxxx. */
  ids: string[];
  /** Most recent modification across this package's advisories. */
  latestModified?: string;
}

export interface AdvisoryDetail {
  id: string;
  summary?: string;
  /** Version ranges the advisory says are affected, flattened for display. */
  affectedRanges: string[];
  /** First version known to fix it, when the advisory states one. */
  firstFixed?: string;
}

interface BatchResponse {
  results?: Array<{ vulns?: Array<{ id: string; modified?: string }> }>;
}

/**
 * Which of these packages have advisories. Batched, chunked, and positional:
 * `results[i]` corresponds to `queries[i]`, so order must be preserved.
 */
export async function findAdvisories(
  packageNames: string[],
  chunkSize = 200,
): Promise<AdvisorySummary[]> {
  const found: AdvisorySummary[] = [];

  for (let i = 0; i < packageNames.length; i += chunkSize) {
    const chunk = packageNames.slice(i, i + chunkSize);
    const body = {
      queries: chunk.map((name) => ({
        package: { name, ecosystem: "npm" },
      })),
    };

    const res = await fetch(OSV_BATCH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`OSV batch query failed: ${res.status} ${res.statusText}`);
    }

    const json = (await res.json()) as BatchResponse;
    const results = json.results ?? [];

    chunk.forEach((name, idx) => {
      const vulns = results[idx]?.vulns ?? [];
      if (vulns.length === 0) return;
      const modified = vulns
        .map((v) => v.modified)
        .filter((m): m is string => typeof m === "string")
        .sort();
      found.push({
        packageName: name,
        ids: vulns.map((v) => v.id),
        latestModified: modified[modified.length - 1],
      });
    });
  }

  // Most advisories first: a package with many is the more urgent read.
  return found.sort((a, b) => b.ids.length - a.ids.length);
}

interface QueryResponse {
  vulns?: Array<{
    id: string;
    summary?: string;
    affected?: Array<{
      ranges?: Array<{
        events?: Array<{ introduced?: string; fixed?: string }>;
      }>;
    }>;
  }>;
}

/** Full advisory detail for one package, including the first fixed version. */
export async function fetchAdvisoryDetails(
  packageName: string,
): Promise<AdvisoryDetail[]> {
  const res = await fetch(OSV_QUERY, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ package: { name: packageName, ecosystem: "npm" } }),
  });
  if (!res.ok) {
    throw new Error(`OSV query failed: ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as QueryResponse;
  return (json.vulns ?? []).map((v) => {
    const ranges: string[] = [];
    let firstFixed: string | undefined;
    for (const a of v.affected ?? []) {
      for (const r of a.ranges ?? []) {
        for (const e of r.events ?? []) {
          if (e.introduced) ranges.push(`>=${e.introduced}`);
          if (e.fixed) {
            ranges.push(`<${e.fixed}`);
            // Keep the lowest fixed version seen, which is the cheapest upgrade.
            if (!firstFixed || e.fixed.localeCompare(firstFixed) < 0) {
              firstFixed = e.fixed;
            }
          }
        }
      }
    }
    return {
      id: v.id,
      summary: v.summary,
      affectedRanges: [...new Set(ranges)],
      firstFixed,
    };
  });
}

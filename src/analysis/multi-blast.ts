import { runQuery } from "../db/connection.js";
import type { IdRegistry } from "../db/id-registry.js";

/**
 * Multi-source blast radius using HydraDB's native `algo.MSpaths`.
 *
 * The track's own framing is "a package is compromised at 09:00, which services
 * are exposed by 09:06", and real incidents are never one package: the May 2026
 * TanStack compromise published 84 malicious versions across 42 packages in six
 * minutes. Answering that with the ordinary traversal means N round trips in a
 * client-side loop, with the fan-out and the merge both done in TypeScript.
 *
 * MSpaths resolves many indexed sources in a single call inside the engine.
 * That is what the procedure exists for, and it is the query this project most
 * wants from HydraDB specifically.
 *
 * Two hard requirements, both learned from the engine source:
 *  - the statement must START with `CALL algo.`, otherwise
 *    `is_native_path_procedure` does not match, the statement falls through to
 *    the generic clause walker, and CALL is not in that walker's allowed set
 *  - sources are INDEXED SELECTORS (label + property + values), not bound nodes
 */

/**
 * Paths to return per source. The procedure's default is 1, which yields a
 * single shortest path per source and under-reports reachability. High enough
 * to enumerate a realistic blast radius, bounded so a pathological graph cannot
 * hang the query.
 */
const PATH_COUNT = 5000;
const RESULT_LIMIT = 20000;

export interface MultiBlastResult {
  sources: string[];
  affected: string[];
  pathsReturned: number;
  /** True when the native procedure ran; false when the fallback was used. */
  native: boolean;
}

/** A path value as the Bolt driver surfaces it. Shape is defensive on purpose:
 * this is the first code to consume MSpaths output, so nothing is assumed. */
interface DriverNode {
  properties?: Record<string, unknown>;
}
interface DriverPath {
  start?: DriverNode;
  end?: DriverNode;
  segments?: Array<{ start?: DriverNode; end?: DriverNode }>;
}

function nameOf(node: unknown): string | undefined {
  const props = (node as DriverNode | undefined)?.properties;
  const name = props?.["name"];
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

/** Collect every package name appearing anywhere along a path. */
function namesInPath(path: DriverPath): string[] {
  const out: string[] = [];
  const push = (n: unknown) => {
    const v = nameOf(n);
    if (v) out.push(v);
  };
  push(path.start);
  push(path.end);
  for (const seg of path.segments ?? []) {
    push(seg.start);
    push(seg.end);
  }
  return out;
}

/**
 * Escapes a package name for embedding in a Cypher string literal. The
 * procedure takes selector values inline, and npm names can contain quotes and
 * backslashes, so this is not optional.
 */
function cypherString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/**
 * Blast radius for many compromised packages at once.
 *
 * Returns `native: false` and an empty result if the procedure is unavailable,
 * so the caller can fall back to per-package traversal rather than fail. The
 * working path is never removed in favour of the faster one.
 */
export async function multiBlastRadius(
  registry: IdRegistry,
  packageNames: string[],
  maxDepth = 5,
): Promise<MultiBlastResult> {
  // Only query for packages actually present in the graph; an unknown selector
  // value would silently contribute nothing and make the result look complete.
  const known = packageNames.filter(
    (n) => registry.lookup("package", n) !== undefined,
  );
  if (known.length === 0) {
    return { sources: [], affected: [], pathsReturned: 0, native: true };
  }

  const depth = Math.max(1, Math.min(20, Math.floor(maxDepth)));
  const values = known.map(cypherString).join(", ");

  // Must start with CALL. Traverses the materialised reverse edge outward,
  // which is how "who depends on these" is expressed here.
  //
  // pathCount is explicit and high on purpose. It defaults to 1
  // (query/path_procedure.rs: config_u64(..., "pathCount").unwrap_or(1)), which
  // returns a single shortest path per source and silently under-reports the
  // blast radius: the first version of this omitted it and found 2 affected
  // packages where the plain traversal found 3.
  const query =
    `CALL algo.MSpaths({sourceLabel: 'Package', sourceProperty: 'name', ` +
    `sourceValues: [${values}], relTypes: ['DEPENDED_ON_BY'], ` +
    `maxLen: ${depth}, relDirection: 'outgoing', ` +
    `pathCount: ${PATH_COUNT}, resultLimit: ${RESULT_LIMIT}}) ` +
    `YIELD path RETURN path`;

  let rows: Array<{ path: DriverPath }>;
  try {
    rows = await runQuery<{ path: DriverPath }>(query);
  } catch {
    return { sources: known, affected: [], pathsReturned: 0, native: false };
  }

  const sourceSet = new Set(known);
  const affected = new Set<string>();
  for (const row of rows) {
    for (const name of namesInPath(row.path)) {
      // The sources themselves are already known to be compromised.
      if (!sourceSet.has(name)) affected.add(name);
    }
  }

  return {
    sources: known,
    affected: [...affected].sort(),
    pathsReturned: rows.length,
    native: true,
  };
}

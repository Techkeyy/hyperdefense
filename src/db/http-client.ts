/**
 * HydraDB HTTP query transport.
 *
 * Why this exists rather than using the Bolt driver everywhere: the Bolt path
 * intermittently throws `The value of 'offset' is out of range ... Received N`
 * from inside neo4j-driver's buffer decode. It is triggered by concurrent
 * queries and, independently, by larger responses, so it grew more frequent as
 * the graph did. Running queries sequentially reduced it but did not remove it,
 * because response size alone is enough. It is a chunking incompatibility
 * between the driver and HydraDB's Bolt implementation, and not something this
 * project can fix from the outside.
 *
 * The HTTP API is a plain JSON request/response with explicit cursor
 * pagination, so it avoids the decoder entirely and handles large result sets
 * properly. Reads and writes both go through it.
 *
 * Contract (src/client/http.rs):
 *   POST {base}/v1/graphs/{graph}/query
 *   headers: Authorization: Bearer <token>, X-Graph-Namespace: <ns>
 *   body:    { cell_id, query, parameters, page_size?, cursor? }
 *   200:     { query_id, columns: string[], rows: TaggedValue[][], next_cursor? }
 *
 * Values are tagged: { "type": "string", "value": "x" }.
 */

export interface HttpConfig {
  base: string;
  token: string;
  graph: string;
  namespace: string;
  cellId: string;
}

export function getHttpConfig(): HttpConfig {
  return {
    base: process.env.HYDRA_HTTP ?? "http://127.0.0.1:8443",
    token: process.env.HYDRA_TOKEN ?? "local-development-token-32-bytes",
    graph: process.env.HYDRA_GRAPH ?? "default",
    namespace: process.env.HYDRA_NAMESPACE ?? "default",
    cellId: process.env.HYDRA_CELL ?? "cell-0",
  };
}

/** A path node/relationship as the HTTP API serialises it. */
export interface HttpPathNode {
  id: number;
  labels: string[];
  properties: Record<string, unknown>;
}
export interface HttpPath {
  nodes?: HttpPathNode[];
  relationships?: Array<{
    id?: number;
    edge_type: string;
    src: number;
    dst: number;
    properties?: Record<string, unknown>;
  }>;
}

type Tagged = { type: string; value?: unknown };

/**
 * Decode a `VertexPropertyValue`, which uses a DIFFERENT serde shape from the
 * row-level values above.
 *
 * Row values are adjacently tagged (`#[serde(tag="type", content="value")]`),
 * so they arrive as `{"type":"string","value":"x"}`. `VertexPropertyValue`
 * carries no such attribute, so serde's default externally-tagged form applies
 * and it arrives as `{"String":"x"}` with the Rust variant name as the key.
 *
 * Getting this wrong is silent rather than loud: the decoder returns the raw
 * object, every property lookup misses, and paths come back with no names, so
 * the query looks like it simply found nothing. That is exactly what happened
 * on the first HTTP run: attack-path reported 0 paths where Bolt found 3.
 */
export function decodePropertyValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object") return v;

  const obj = v as Record<string, unknown>;
  // Externally tagged: exactly one key, the Rust variant name.
  if ("String" in obj) return String(obj.String ?? "");
  if ("Integer" in obj) return Number(obj.Integer);
  if ("SignedInteger" in obj) return Number(obj.SignedInteger);
  if ("Bool" in obj) return Boolean(obj.Bool);
  if ("Float" in obj) {
    // QueryFloat is a newtype, so it may arrive bare or wrapped.
    const f = obj.Float as unknown;
    if (f !== null && typeof f === "object" && "0" in (f as object)) {
      return Number((f as Record<string, unknown>)["0"]);
    }
    return Number(f);
  }
  // Adjacently tagged after all, or an unrecognised shape: fall through.
  if (typeof obj.type === "string") return decodeValue(obj);
  return v;
}

/** Unwrap one tagged value into a plain JS value. */
function decodeValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object") return v;
  const tagged = v as Tagged;
  if (typeof tagged.type !== "string") return v;

  switch (tagged.type) {
    case "null":
      return null;
    case "vertex_id":
    case "integer":
    case "signed_integer":
    case "float":
      return Number(tagged.value);
    case "boolean":
      return Boolean(tagged.value);
    case "string":
      return String(tagged.value ?? "");
    case "list":
      return Array.isArray(tagged.value)
        ? tagged.value.map(decodeValue)
        : [];
    case "path":
      return decodePath(tagged.value);
    default:
      return tagged.value ?? null;
  }
}

/**
 * Normalises an HTTP path into the shape the analysis layer already consumes
 * (start/end/segments with `properties`), so path handling is identical
 * regardless of transport.
 */
export function decodePath(raw: unknown): unknown {
  const p = raw as HttpPath | undefined;
  const nodes = p?.nodes ?? [];
  if (nodes.length === 0) return { start: undefined, end: undefined, segments: [] };

  const asNode = (n: HttpPathNode) => ({
    properties: Object.fromEntries(
      Object.entries(n.properties ?? {}).map(([k, val]) => [
        k,
        // Node properties use decodePropertyValue, NOT decodeValue: they are a
        // different serde shape. See that function.
        decodePropertyValue(val),
      ]),
    ),
  });

  const segments = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    segments.push({ start: asNode(nodes[i]), end: asNode(nodes[i + 1]) });
  }
  return {
    start: asNode(nodes[0]),
    end: asNode(nodes[nodes.length - 1]),
    segments,
  };
}

/**
 * Parameters go over JSON, so driver Integer wrappers must be unwrapped. Every
 * id in this project is a compact integer, well inside the safe range.
 */
function normaliseParams(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    out[k] = normaliseValue(v);
  }
  return out;
}

function normaliseValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map(normaliseValue);
  if (typeof v === "object") {
    // neo4j-driver Integer: { low, high } with a toNumber().
    const maybeInt = v as { toNumber?: () => number; low?: number };
    if (typeof maybeInt.toNumber === "function") return maybeInt.toNumber();
    if (typeof maybeInt.low === "number" && "high" in maybeInt) {
      return maybeInt.low;
    }
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, val]) => [
        k,
        normaliseValue(val),
      ]),
    );
  }
  return v;
}

interface HttpQueryResponse {
  columns?: string[];
  rows?: unknown[][];
  next_cursor?: number | null;
}

/**
 * Run a query over HTTP, following cursor pagination until exhausted.
 */
export async function runHttpQuery<T = Record<string, unknown>>(
  cypher: string,
  params: Record<string, unknown> = {},
  pageSize = 1000,
): Promise<T[]> {
  const cfg = getHttpConfig();
  const url = `${cfg.base}/v1/graphs/${encodeURIComponent(cfg.graph)}/query`;

  const out: T[] = [];
  let cursor: number | undefined;
  // Bound the loop: a server that always returns a cursor must not hang the CLI.
  for (let page = 0; page < 1000; page++) {
    const body: Record<string, unknown> = {
      cell_id: cfg.cellId,
      query: cypher,
      parameters: normaliseParams(params),
      page_size: pageSize,
    };
    if (cursor !== undefined) body.cursor = cursor;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "X-Graph-Namespace": cfg.namespace,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `HydraDB HTTP ${res.status}: ${text.slice(0, 400) || res.statusText}`,
      );
    }

    const json = (await res.json()) as HttpQueryResponse;
    const columns = json.columns ?? [];
    for (const row of json.rows ?? []) {
      const obj: Record<string, unknown> = {};
      columns.forEach((col, i) => {
        obj[col] = decodeValue(row[i]);
      });
      out.push(obj as T);
    }

    const next = json.next_cursor;
    if (next === null || next === undefined) break;
    cursor = next;
  }

  return out;
}

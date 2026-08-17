import { fetchPackage } from "../ingest/npm-registry.js";

export interface RegistryCheck {
  field: string;
  matters: string;
  present: boolean;
  sample?: string;
}

/**
 * Confirms the live npm payload actually carries the fields the ingester reads.
 * A parser that quietly returns empty while every self-referential test passes
 * is the failure this exists to catch, so each field is asserted as populated,
 * not merely present.
 */
export async function probeRegistry(
  // Must be a package that genuinely HAS dependencies. npm omits the
  // `dependencies` key entirely when a package has none, so probing a
  // dependency-free package (chalk, for one) cannot tell "parser works" apart
  // from "parser returns nothing".
  packageName = "express",
): Promise<{ ok: boolean; checks: RegistryCheck[]; error?: string }> {
  let pkg;
  try {
    pkg = await fetchPackage(packageName);
  } catch (err) {
    return {
      ok: false,
      checks: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const latest = pkg["dist-tags"]?.latest;
  const versionData = latest ? pkg.versions?.[latest] : undefined;
  const maintainers = pkg.maintainers ?? [];
  const publishTime = latest ? pkg.time?.[latest] : undefined;
  const deps = versionData?.dependencies ?? {};

  const checks: RegistryCheck[] = [
    {
      field: "name",
      matters: "package node identity",
      present: typeof pkg.name === "string" && pkg.name.length > 0,
      sample: pkg.name,
    },
    {
      field: "dist-tags.latest",
      matters: "selects which version's dependency list is ingested",
      present: typeof latest === "string" && latest.length > 0,
      sample: latest,
    },
    {
      field: "versions[latest]",
      matters: "the version record carrying the dependency map",
      present: !!versionData,
      sample: versionData ? `${latest}` : "missing",
    },
    {
      field: "versions[latest].dependencies",
      matters:
        "the entire dependency graph layer; asserted non-empty because an absent key is valid npm for a dependency-free package and would mask a broken parser",
      present: Object.keys(deps).length > 0,
      sample: `${Object.keys(deps).length} deps: ${Object.keys(deps)
        .slice(0, 3)
        .join(", ")}`,
    },
    {
      field: "maintainers[]",
      matters:
        "the maintainer graph layer, the project's main differentiator; if this is empty the lateral movement analysis has nothing to work with",
      present: maintainers.length > 0,
      sample: maintainers
        .slice(0, 3)
        .map((m) => m.name)
        .join(", "),
    },
    {
      field: "time[latest]",
      matters: "the temporal layer, exposure window arithmetic",
      present: typeof publishTime === "string" && publishTime.length > 0,
      sample: publishTime,
    },
  ];

  return { ok: checks.every((c) => c.present), checks };
}

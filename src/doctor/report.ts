import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ConnectionResult, ProbeResult } from "./probe.js";
import type { RegistryCheck } from "./registry-probe.js";

export interface ReportInput {
  connection: ConnectionResult;
  probes: ProbeResult[];
  registry: { ok: boolean; checks: RegistryCheck[]; error?: string };
}

const STATUS_MARK: Record<ProbeResult["status"], string> = {
  supported: "yes",
  unsupported: "no",
  "wrong-result": "wrong result",
};

/**
 * Writes the measured capability matrix to disk. Committed so the design record
 * shows what was observed rather than what was assumed.
 */
export async function writeCapabilityReport(
  input: ReportInput,
  path = "docs/CAPABILITIES.md",
): Promise<void> {
  const { connection, probes, registry } = input;
  const now = new Date().toISOString();

  const lines: string[] = [
    "# HydraDB capability matrix",
    "",
    `Measured ${now} by \`hyperdefense doctor\` against a live server.`,
    "Every row here was executed, not inferred from documentation.",
    "",
    "## Connection",
    "",
    `- uri: \`${connection.uri}\``,
    `- scheme: \`${connection.scheme}\` ${
      connection.scheme === "bolt"
        ? "(direct, bypasses routing)"
        : "(routed, follows the server's advertised address)"
    }`,
    `- auth: \`${connection.auth}\``,
    "",
    "## Cypher features",
    "",
    "| feature | supported | why it matters | detail |",
    "|---------|-----------|----------------|--------|",
  ];

  for (const p of probes) {
    const detail = (p.detail ?? "").replace(/\|/g, "\\|").slice(0, 120);
    lines.push(
      `| ${p.label} | ${STATUS_MARK[p.status]} | ${p.matters} | ${detail} |`,
    );
  }

  lines.push("", "## npm registry payload", "");
  if (registry.error) {
    lines.push(`Registry probe failed: \`${registry.error}\``);
  } else {
    lines.push("| field | present | why it matters | sample |");
    lines.push("|-------|---------|----------------|--------|");
    for (const c of registry.checks) {
      const sample = (c.sample ?? "").replace(/\|/g, "\\|").slice(0, 60);
      lines.push(
        `| \`${c.field}\` | ${c.present ? "yes" : "no"} | ${c.matters} | ${sample} |`,
      );
    }
  }

  const unsupported = probes.filter((p) => p.status !== "supported");
  lines.push("", "## Consequences for the build", "");
  if (unsupported.length === 0) {
    lines.push(
      "All probed features are supported. The traversal layer can use standard",
      "Cypher, with the native `algo.*` procedures as a fast path.",
    );
  } else {
    lines.push("These features are not usable and the query layer must route around them:", "");
    for (const p of unsupported) {
      lines.push(`- **${p.label}** (${STATUS_MARK[p.status]}): ${p.detail ?? "no detail"}`);
    }
  }
  lines.push("");

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, lines.join("\n"), "utf8");
}

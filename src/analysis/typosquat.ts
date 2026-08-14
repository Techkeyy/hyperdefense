import { runQuery } from "../db/connection.js";
import { QUERIES } from "../db/queries.js";

export interface TyposquatCandidate {
  original: string;
  suspect: string;
  distance: number;
  type: "swap" | "omit" | "insert" | "replace" | "prefix";
}

function levenshtein(a: string, b: string): number {
  const matrix: number[][] = [];
  for (let i = 0; i <= a.length; i++) matrix[i] = [i];
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }
  return matrix[a.length][b.length];
}

function classifyTyposquat(
  original: string,
  suspect: string,
): TyposquatCandidate["type"] {
  if (suspect.length === original.length) {
    // Check for adjacent character swap
    let swaps = 0;
    for (let i = 0; i < original.length - 1; i++) {
      if (
        original[i] === suspect[i + 1] &&
        original[i + 1] === suspect[i]
      ) {
        swaps++;
      }
    }
    if (swaps > 0) return "swap";
    return "replace";
  }
  if (suspect.length === original.length - 1) return "omit";
  if (suspect.length === original.length + 1) return "insert";
  if (suspect.startsWith(original) || original.startsWith(suspect))
    return "prefix";
  return "replace";
}

export async function findTyposquats(
  packageName: string,
  maxDistance = 2,
): Promise<TyposquatCandidate[]> {
  const allNames = await runQuery<{ name: string }>(QUERIES.allPackageNames);
  const baseName = packageName.replace(/^@[^/]+\//, "");

  const candidates: TyposquatCandidate[] = [];

  for (const { name } of allNames) {
    if (name === packageName) continue;
    const compareName = name.replace(/^@[^/]+\//, "");
    const dist = levenshtein(baseName, compareName);
    if (dist > 0 && dist <= maxDistance) {
      candidates.push({
        original: packageName,
        suspect: name,
        distance: dist,
        type: classifyTyposquat(baseName, compareName),
      });
    }
  }

  return candidates.sort((a, b) => a.distance - b.distance);
}

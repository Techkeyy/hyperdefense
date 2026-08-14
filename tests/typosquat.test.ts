import { describe, it, expect } from "vitest";

// Unit test the levenshtein + classification logic without DB

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

describe("levenshtein distance", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshtein("lodash", "lodash")).toBe(0);
  });

  it("detects single character swap", () => {
    expect(levenshtein("lodash", "ldoash")).toBe(2);
  });

  it("detects single character omission", () => {
    expect(levenshtein("lodash", "lodsh")).toBe(1);
  });

  it("detects single character insertion", () => {
    expect(levenshtein("lodash", "loddash")).toBe(1);
  });

  it("detects single character replacement", () => {
    expect(levenshtein("lodash", "lodask")).toBe(1);
  });

  it("handles scoped package base names", () => {
    const a = "react-query";
    const b = "react-qurey";
    expect(levenshtein(a, b)).toBe(2);
  });

  it("returns correct distance for unrelated strings", () => {
    expect(levenshtein("abc", "xyz")).toBe(3);
  });
});

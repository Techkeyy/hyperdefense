export interface NpmPackageData {
  name: string;
  description?: string;
  "dist-tags"?: Record<string, string>;
  versions?: Record<string, NpmVersionData>;
  maintainers?: NpmMaintainer[];
  time?: Record<string, string>;
}

export interface NpmVersionData {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface NpmMaintainer {
  name: string;
  email?: string;
}

const REGISTRY = "https://registry.npmjs.org";

export async function fetchPackage(name: string): Promise<NpmPackageData> {
  const url = `${REGISTRY}/${encodeURIComponent(name)}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`npm registry returned ${res.status} for ${name}`);
  }
  return res.json() as Promise<NpmPackageData>;
}

export async function fetchTopPackages(count: number): Promise<string[]> {
  const res = await fetch(
    `https://api.npmjs.org/v1/security/advisories?perPage=${count}`,
  );

  // Fallback: use a curated seed list of high-impact packages
  return SEED_PACKAGES.slice(0, count);
}

export const SEED_PACKAGES = [
  "lodash",
  "chalk",
  "react",
  "express",
  "axios",
  "tslib",
  "commander",
  "request",
  "moment",
  "debug",
  "uuid",
  "glob",
  "minimist",
  "semver",
  "yargs",
  "fs-extra",
  "dotenv",
  "inquirer",
  "rxjs",
  "bluebird",
  "async",
  "underscore",
  "body-parser",
  "webpack",
  "typescript",
  "eslint",
  "prettier",
  "mkdirp",
  "rimraf",
  "cross-env",
  "@tanstack/react-query",
  "@tanstack/router",
  "next",
  "vue",
  "angular",
  "svelte",
  "vite",
  "esbuild",
  "rollup",
  "babel-core",
  "postcss",
  "tailwindcss",
  "prisma",
  "mongoose",
  "pg",
  "redis",
  "ioredis",
  "socket.io",
  "jsonwebtoken",
  "bcrypt",
  "cors",
  "helmet",
  "morgan",
  "compression",
  "multer",
  "nodemailer",
  "puppeteer",
  "cheerio",
  "got",
  "node-fetch",
  "ora",
  "chalk",
  "keyv",
  "cacheable",
  "flat-cache",
  "file-entry-cache",
  "nx",
  "@mistralai/mistralai",
  "@uipath/robot",
  "opensearch-js",
];

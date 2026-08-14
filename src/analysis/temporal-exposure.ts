import { runQuery } from "../db/connection.js";
import { QUERIES } from "../db/queries.js";

export interface ExposureWindow {
  packageName: string;
  compromisedAt: string;
  detectedAt: string;
  versionsPublished: Array<{ version: string; publishedAt: string }>;
  consumersExposed: string[];
  windowDurationHours: number;
}

export async function analyzeTemporalExposure(
  packageName: string,
  compromisedAt: string,
  detectedAt: string,
): Promise<ExposureWindow> {
  const [versions, consumers] = await Promise.all([
    runQuery<{ version: string; publishedAt: string }>(
      QUERIES.temporalExposure,
      {
        package: packageName,
        windowStart: compromisedAt,
        windowEnd: detectedAt,
      },
    ),
    runQuery<{ consumer: string }>(QUERIES.consumersInWindow, {
      package: packageName,
    }),
  ]);

  const start = new Date(compromisedAt).getTime();
  const end = new Date(detectedAt).getTime();
  const windowHours = (end - start) / (1000 * 60 * 60);

  return {
    packageName,
    compromisedAt,
    detectedAt,
    versionsPublished: versions,
    consumersExposed: consumers.map((c) => c.consumer),
    windowDurationHours: Math.round(windowHours * 10) / 10,
  };
}

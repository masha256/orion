import type { DriverReport } from '../drivers/compute.js';

export type Grade = 'A' | 'B' | 'C' | 'D';

/** `degradedByAnomaly`: an open degrading anomaly exists on a critical metric. */
export function gradeDataQuality(report: DriverReport, degradedByAnomaly = false): Grade {
  if (report.staleCritical.length > 0 || degradedByAnomaly) return 'D';
  if (report.provisionalMetrics.length > 0 || report.staleMetrics.length > 0) return 'C';
  if (report.manualMetrics.length > 0) return 'B';
  return 'A';
}

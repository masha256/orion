import type { DriverReport } from '../drivers/compute.js';

export type Grade = 'A' | 'B' | 'C' | 'D';

export function gradeDataQuality(report: DriverReport): Grade {
  if (report.staleCritical.length > 0) return 'D';
  if (report.provisionalMetrics.length > 0 || report.staleMetrics.length > 0) return 'C';
  if (report.manualMetrics.length > 0) return 'B';
  return 'A';
}

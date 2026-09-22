import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { emitTickReport, tickId, type TickReport } from '../../src/app/tickReport.js';

/** A minimal but schema-valid report: `run_in_progress`, lock set, everything else at its empty/absent value. */
function minimalReport(): TickReport {
  return {
    schema_version: 1, tick_id: 'tick_mini_20260919T120005Z', asset: 'mini', started_at: '2026-09-19T12:00:05.000Z', ended_at: '2026-09-19T12:00:05.000Z',
    outcome: 'run_in_progress', lock: { holder: 'tick pid 1', acquired_at: '2026-09-19T12:00:00.000Z' },
    ingest: null, signal: null, triggers_fired: [], triggers_recorded: false, agent: null, agent_would_run: null, error: null,
  };
}

describe('emitTickReport', () => {
  it('writes a valid report as one JSON line, and appends it plus a newline to outFile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orion-tickreport-'));
    const outFile = join(dir, 'signals.jsonl');
    const written: string[] = [];
    const report = minimalReport();

    emitTickReport(report, { write: (line) => written.push(line), outFile });

    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0])).toEqual(report);
    const fileContents = readFileSync(outFile, 'utf8');
    expect(fileContents).toBe(written[0] + '\n');
    expect(fileContents.split('\n').filter((l) => l.length > 0)).toHaveLength(1);
  });

  it('throws on an invalid report, never calling write, and never creating outFile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orion-tickreport-'));
    const outFile = join(dir, 'signals.jsonl');
    const written: string[] = [];
    const invalid = { ...minimalReport(), outcome: 'nope' } as unknown as TickReport;

    expect(() => emitTickReport(invalid, { write: (line) => written.push(line), outFile })).toThrow(ZodError);
    expect(written).toHaveLength(0);
    expect(existsSync(outFile)).toBe(false);
  });

  it('with no outFile, only calls write', () => {
    const written: string[] = [];
    const report = minimalReport();

    emitTickReport(report, { write: (line) => written.push(line) });

    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0])).toEqual(report);
  });
});

describe('tickId', () => {
  it('formats the asset and started time with no separators, to the second, ending in Z', () => {
    expect(tickId('mini', new Date('2026-09-19T12:00:05.123Z'))).toBe('tick_mini_20260919T120005Z');
  });
});

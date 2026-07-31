import * as fs from 'fs';
import * as path from 'path';

/**
 * A single recorded performance metric. `value` is the primary measured
 * quantity (bytes, calls, or milliseconds); `meta` carries optional context
 * such as the batch count used to derive per-batch overhead.
 */
export interface MetricEntry {
  name: string;
  value: number;
  meta?: Record<string, number>;
}

/** Custom metrics captured by the benchmark suite beyond raw timing. */
export interface BenchMetrics {
  /** Heap deltas in bytes for large JSONL parsing. */
  memory: MetricEntry[];
  /** runOpenCode call counts per review scenario. */
  apiCalls: MetricEntry[];
  /** Wall-clock latencies in milliseconds per review scenario. */
  e2eLatency: MetricEntry[];
}

const METRICS_FILE = path.resolve(process.cwd(), 'bench-metrics.json');

let lastSerialized = '';

/**
 * Persist custom benchmark metrics to `bench-metrics.json`. Writes are skipped
 * when the serialized payload is unchanged so that time-boxed benchmark loops
 * do not hammer the disk.
 * @param metrics - The metrics to persist.
 */
export function writeMetrics(metrics: BenchMetrics): void {
  const serialized = JSON.stringify(metrics, null, 2);
  if (serialized === lastSerialized) return;
  lastSerialized = serialized;
  fs.writeFileSync(METRICS_FILE, serialized);
}

/**
 * Remove a metric entry by name (case-sensitive prefix match on the entry name).
 * @param entries - The metric list to filter.
 * @param namePrefix - Prefix used to select entries to drop.
 * @returns A new array without the removed entries.
 */
export function dropMetrics(entries: MetricEntry[], namePrefix: string): MetricEntry[] {
  return entries.filter((e) => !e.name.startsWith(namePrefix));
}

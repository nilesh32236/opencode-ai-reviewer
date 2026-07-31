import * as fs from 'fs';
import * as path from 'path';
import { BUDGETS } from './budgets.js';

interface VitestBenchmark {
  name: string;
  hz: number;
  mean: number;
}

interface VitestBenchGroup {
  fullName: string;
  benchmarks: VitestBenchmark[];
}

interface VitestBenchFile {
  filepath: string;
  groups: VitestBenchGroup[];
}

interface BenchResults {
  files: VitestBenchFile[];
}

interface MetricEntry {
  name: string;
  value: number;
  meta?: Record<string, number>;
}

interface BenchMetrics {
  memory: MetricEntry[];
  apiCalls: MetricEntry[];
  e2eLatency: MetricEntry[];
}

interface CheckResult {
  name: string;
  measured: string;
  budget: string;
  passed: boolean;
}

const resultsPath = path.resolve(process.cwd(), 'bench-results.json');
const metricsPath = path.resolve(process.cwd(), 'bench-metrics.json');

function loadBenchResults(): BenchResults {
  if (!fs.existsSync(resultsPath)) {
    console.error(`[budget-check] Missing benchmark output: ${resultsPath}`);
    console.error('Run `pnpm bench` first to generate benchmark results.');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(resultsPath, 'utf-8')) as BenchResults;
}

function loadBenchMetrics(): BenchMetrics {
  const empty: BenchMetrics = { memory: [], apiCalls: [], e2eLatency: [] };
  if (!fs.existsSync(metricsPath)) {
    console.warn(`[budget-check] Missing custom metrics file: ${metricsPath}`);
    return empty;
  }
  return { ...empty, ...(JSON.parse(fs.readFileSync(metricsPath, 'utf-8')) as BenchMetrics) };
}

function allBenchmarks(results: BenchResults): VitestBenchmark[] {
  const flat: VitestBenchmark[] = [];
  for (const file of results.files) {
    for (const group of file.groups) {
      for (const benchmark of group.benchmarks) {
        flat.push({ ...benchmark, name: `${group.fullName} > ${benchmark.name}` });
      }
    }
  }
  return flat;
}

function findBenchmark(
  benchmarks: VitestBenchmark[],
  namePattern: RegExp,
): VitestBenchmark | undefined {
  return benchmarks.find((b) => namePattern.test(b.name));
}

function checkTiming(
  results: CheckResult[],
  benchmarks: VitestBenchmark[],
  namePattern: RegExp,
  label: string,
  budgetMs: number,
): void {
  const benchmark = findBenchmark(benchmarks, namePattern);
  if (!benchmark) {
    results.push({
      name: label,
      measured: 'N/A (benchmark missing)',
      budget: `< ${budgetMs}ms`,
      passed: false,
    });
    return;
  }
  const meanMs = benchmark.mean * 1000;
  results.push({
    name: label,
    measured: `${meanMs.toFixed(3)}ms`,
    budget: `< ${budgetMs}ms`,
    passed: meanMs < budgetMs,
  });
}

function checkThroughput(
  results: CheckResult[],
  benchmarks: VitestBenchmark[],
  namePattern: RegExp,
  label: string,
  lines: number,
  budgetLinesPerSecond: number,
): void {
  const benchmark = findBenchmark(benchmarks, namePattern);
  if (!benchmark) {
    results.push({
      name: label,
      measured: 'N/A (benchmark missing)',
      budget: `>= ${budgetLinesPerSecond.toLocaleString()} lines/s`,
      passed: false,
    });
    return;
  }
  const linesPerSecond = benchmark.hz * lines;
  results.push({
    name: label,
    measured: `${Math.round(linesPerSecond).toLocaleString()} lines/s`,
    budget: `>= ${budgetLinesPerSecond.toLocaleString()} lines/s`,
    passed: linesPerSecond >= budgetLinesPerSecond,
  });
}

function checkMemory(results: CheckResult[], metrics: BenchMetrics): void {
  for (const entry of metrics.memory) {
    const budget = BUDGETS.heapDeltaMaxBytes;
    results.push({
      name: `heap delta ${entry.name}`,
      measured: `${(entry.value / 1024).toFixed(1)} KiB`,
      budget: `< ${(budget / 1024).toFixed(1)} KiB`,
      passed: entry.value < budget,
    });
  }
  if (metrics.memory.length === 0) {
    results.push({
      name: 'heap delta jsonl-parse-2000-lines',
      measured: 'N/A (metric missing)',
      budget: `< ${(BUDGETS.heapDeltaMaxBytes / 1024).toFixed(1)} KiB`,
      passed: false,
    });
  }
}

function checkApiCalls(results: CheckResult[], metrics: BenchMetrics): void {
  for (const entry of metrics.apiCalls) {
    const batches = entry.meta?.batches ?? 1;
    const expected = batches === 1 ? 1 : batches + 1;
    results.push({
      name: `runOpenCode calls ${entry.name}`,
      measured: `${entry.value} calls`,
      budget: `== ${expected} calls`,
      passed: entry.value === expected,
    });
  }
  if (metrics.apiCalls.length === 0) {
    results.push({
      name: 'runOpenCode calls reviewPR-1-files',
      measured: 'N/A (metric missing)',
      budget: '== 1 call',
      passed: false,
    });
  }
}

function checkE2eOverhead(results: CheckResult[], metrics: BenchMetrics): void {
  const baseline = metrics.e2eLatency.find((e) => (e.meta?.batches ?? 1) === 1);
  if (!baseline) {
    results.push({
      name: 'per-batch orchestration overhead',
      measured: 'N/A (baseline missing)',
      budget: `< ${BUDGETS.batchOverheadMaxMs}ms/batch`,
      passed: false,
    });
    return;
  }
  const baselineAdjusted = adjustedLatency(baseline);
  for (const entry of metrics.e2eLatency) {
    const batches = entry.meta?.batches ?? 1;
    if (batches <= 1) continue;
    const overheadPerBatch = (adjustedLatency(entry) - baselineAdjusted) / (batches - 1);
    results.push({
      name: `per-batch overhead ${entry.name}`,
      measured: `${overheadPerBatch.toFixed(1)}ms/batch`,
      budget: `< ${BUDGETS.batchOverheadMaxMs}ms/batch`,
      passed: overheadPerBatch < BUDGETS.batchOverheadMaxMs,
    });
  }
}

/**
 * Subtract fixed inter-chunk backoff delays (150ms per gap between concurrent
 * batch chunks) so the overhead metric reflects real orchestration cost and is
 * independent of the runner's CPU count.
 * @param entry - The latency metric entry.
 * @returns The delay-adjusted latency in milliseconds.
 */
function adjustedLatency(entry: MetricEntry): number {
  const delays = entry.meta?.delays ?? 0;
  const delayMs = entry.meta?.delayMs ?? 150;
  return Math.max(0, entry.value - delays * delayMs);
}

function printTable(results: CheckResult[]): void {
  const nameWidth = Math.max(...results.map((r) => r.name.length), 'Budget'.length);
  const measuredWidth = Math.max(...results.map((r) => r.measured.length), 'Measured'.length);
  const budgetWidth = Math.max(...results.map((r) => r.budget.length), 'Budget'.length);
  const statusWidth = 6;

  const pad = (s: string, width: number): string => s.padEnd(width);
  const header = `${pad('Budget', nameWidth)} | ${pad('Measured', measuredWidth)} | ${pad('Budget', budgetWidth)} | ${pad('Status', statusWidth)}`;
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const r of results) {
    console.log(
      `${pad(r.name, nameWidth)} | ${pad(r.measured, measuredWidth)} | ${pad(r.budget, budgetWidth)} | ${r.passed ? 'PASS' : 'FAIL'}`,
    );
  }
}

function main(): void {
  const results = loadBenchResults();
  const metrics = loadBenchMetrics();
  const benchmarks = allBenchmarks(results);

  const checks: CheckResult[] = [];

  for (const n of [10, 100, 500, 2000]) {
    checkThroughput(
      checks,
      benchmarks,
      new RegExp(`jsonl string parse ${n} lines`),
      `jsonl string parse (${n} lines)`,
      n,
      BUDGETS.jsonlParseLinesPerSecond,
    );
  }

  checkThroughput(
    checks,
    benchmarks,
    /jsonl file parse 500 lines/,
    'jsonl file parse (500 lines)',
    500,
    BUDGETS.jsonlFileParseLinesPerSecond,
  );

  for (const n of [1, 5, 25, 100]) {
    checkTiming(
      checks,
      benchmarks,
      new RegExp(`buildReviewPrompt ${n} files`),
      `buildReviewPrompt (${n} files)`,
      BUDGETS.promptBuildMaxMs,
    );
  }

  for (const n of [0, 10, 50]) {
    checkTiming(
      checks,
      benchmarks,
      new RegExp(`buildFixPrompt ${n} issues`),
      `buildFixPrompt (${n} issues)`,
      BUDGETS.promptBuildMaxMs,
    );
  }

  checkTiming(checks, benchmarks, /buildAuditPrompt/, 'buildAuditPrompt', BUDGETS.promptBuildMaxMs);

  for (const n of [1, 5, 25, 100]) {
    checkTiming(
      checks,
      benchmarks,
      new RegExp(`buildPRContextString ${n} files`),
      `buildPRContextString (${n} files)`,
      BUDGETS.contextBuildMaxMs,
    );
  }

  checkMemory(checks, metrics);
  checkApiCalls(checks, metrics);
  checkE2eOverhead(checks, metrics);

  printTable(checks);

  const failures = checks.filter((c) => !c.passed);
  if (failures.length > 0) {
    console.error(
      `\n[budget-check] ${failures.length} budget(s) exceeded. See table above for details.`,
    );
    process.exitCode = 1;
  } else {
    console.log('\n[budget-check] All performance budgets within limits.');
  }
}

main();

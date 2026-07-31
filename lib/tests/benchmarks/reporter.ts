import * as fs from 'fs';
import * as path from 'path';
import { INTER_CHUNK_DELAY_MS, expectedReviewOpenCodeCalls } from '../../src/engine.js';
import { BUDGETS, type BudgetName } from './budgets.js';

function getBudget(name: BudgetName): number {
  return BUDGETS[name];
}

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

/**
 * Locate the benchmark whose full name matches `namePattern`. Patterns must be
 * anchored to the benchmark-name suffix so a name cannot accidentally be a
 * substring of another (e.g. 'buildPRContextString 1 files' vs
 * 'buildPRContextString 1 files tokenBudget'). Ambiguity is reported as a
 * missing benchmark so a future rename fails CI instead of silently checking
 * the wrong benchmark.
 */
function findBenchmark(
  benchmarks: VitestBenchmark[],
  namePattern: RegExp,
): VitestBenchmark | undefined {
  const matches = benchmarks.filter((b) => namePattern.test(b.name));
  return matches.length === 1 ? matches[0] : undefined;
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
  const meanMs = benchmark.mean;
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

const MEMORY_METRIC_NAMES = ['jsonl-parse-2000-lines'] as const;
const E2E_METRIC_NAMES = ['reviewPR-1-files', 'reviewPR-5-files', 'reviewPR-25-files'] as const;

function checkMemory(results: CheckResult[], metrics: BenchMetrics): void {
  const budget = getBudget('heapDeltaMaxBytes');
  const budgetLabel = `< ${(budget / 1024).toFixed(1)} KiB`;
  for (const expected of MEMORY_METRIC_NAMES) {
    const entry = metrics.memory.find((e) => e.name === expected);
    if (!entry) {
      results.push({
        name: `heap delta ${expected}`,
        measured: 'N/A (metric missing)',
        budget: budgetLabel,
        passed: false,
      });
      continue;
    }
    results.push({
      name: `heap delta ${entry.name}`,
      measured: `${(entry.value / 1024).toFixed(1)} KiB`,
      budget: budgetLabel,
      passed: entry.value < budget,
    });
  }
}

function checkApiCalls(results: CheckResult[], metrics: BenchMetrics): void {
  for (const expected of E2E_METRIC_NAMES) {
    const entry = metrics.apiCalls.find((e) => e.name === expected);
    if (!entry) {
      results.push({
        name: `runOpenCode calls ${expected}`,
        measured: 'N/A (metric missing)',
        budget: '== expected calls',
        passed: false,
      });
      continue;
    }
    const batches = entry.meta?.batches ?? 1;
    const expectedCalls = expectedReviewOpenCodeCalls(batches);
    results.push({
      name: `runOpenCode calls ${entry.name}`,
      measured: `${entry.value} calls`,
      budget: `== ${expectedCalls} calls`,
      passed: entry.value === expectedCalls,
    });
  }
}

function checkE2eOverhead(results: CheckResult[], metrics: BenchMetrics): void {
  const overheadBudget = getBudget('batchOverheadMaxMs');
  const latencyBudget = getBudget('reviewLatencyMaxMs');
  const overheadLabel = `< ${overheadBudget}ms/batch`;
  const latencyLabel = `< ${latencyBudget}ms`;

  const baseline = metrics.e2eLatency.find((e) => (e.meta?.batches ?? 1) === 1);
  const baselineAdjusted = baseline === undefined ? undefined : adjustedLatency(baseline);

  for (const expected of E2E_METRIC_NAMES) {
    const entry = metrics.e2eLatency.find((e) => e.name === expected);
    if (!entry) {
      results.push({
        name: `reviewPR latency ${expected}`,
        measured: 'N/A (metric missing)',
        budget: latencyLabel,
        passed: false,
      });
      results.push({
        name: `per-batch overhead ${expected}`,
        measured: 'N/A (metric missing)',
        budget: overheadLabel,
        passed: false,
      });
      continue;
    }
    results.push({
      name: `reviewPR latency ${entry.name}`,
      measured: `${adjustedLatency(entry).toFixed(2)}ms`,
      budget: latencyLabel,
      passed: adjustedLatency(entry) < latencyBudget,
    });
    const batches = entry.meta?.batches ?? 1;
    if (batches <= 1) continue;
    if (baselineAdjusted === undefined) {
      results.push({
        name: `per-batch overhead ${entry.name}`,
        measured: 'N/A (baseline missing)',
        budget: overheadLabel,
        passed: false,
      });
      continue;
    }
    const overheadPerBatch = (adjustedLatency(entry) - baselineAdjusted) / (batches - 1);
    results.push({
      name: `per-batch overhead ${entry.name}`,
      measured: `${overheadPerBatch.toFixed(1)}ms/batch`,
      budget: overheadLabel,
      passed: overheadPerBatch < overheadBudget,
    });
  }
}

/**
 * Subtract fixed inter-chunk backoff delays (150ms per gap between concurrent
 * batch chunks) so both the overhead and the absolute latency metric reflect
 * real orchestration cost and are independent of the runner's CPU count.
 * @param entry - The latency metric entry.
 * @returns The delay-adjusted latency in milliseconds.
 */
function adjustedLatency(entry: MetricEntry): number {
  const delays = entry.meta?.delays ?? 0;
  const delayMs = entry.meta?.delayMs ?? INTER_CHUNK_DELAY_MS;
  return Math.max(0, entry.value - delays * delayMs);
}

function printTable(results: CheckResult[]): void {
  const nameWidth = Math.max(...results.map((r) => r.name.length), 'Check'.length);
  const measuredWidth = Math.max(...results.map((r) => r.measured.length), 'Measured'.length);
  const budgetWidth = Math.max(...results.map((r) => r.budget.length), 'Budget'.length);
  const statusWidth = 6;

  const pad = (s: string, width: number): string => s.padEnd(width);
  const header = `${pad('Check', nameWidth)} | ${pad('Measured', measuredWidth)} | ${pad('Budget', budgetWidth)} | ${pad('Status', statusWidth)}`;
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
      new RegExp(`jsonl string parse ${n} lines$`),
      `jsonl string parse (${n} lines)`,
      n,
      BUDGETS.jsonlParseLinesPerSecond,
    );
  }

  checkThroughput(
    checks,
    benchmarks,
    /jsonl file parse 500 lines$/,
    'jsonl file parse (500 lines)',
    500,
    BUDGETS.jsonlFileParseLinesPerSecond,
  );

  for (const n of [1, 5, 25, 100]) {
    checkTiming(
      checks,
      benchmarks,
      new RegExp(`buildReviewPrompt ${n} files$`),
      `buildReviewPrompt (${n} files)`,
      BUDGETS.promptBuildMaxMs,
    );
  }

  for (const n of [0, 10, 50]) {
    checkTiming(
      checks,
      benchmarks,
      new RegExp(`buildFixPrompt ${n} issues$`),
      `buildFixPrompt (${n} issues)`,
      BUDGETS.promptBuildMaxMs,
    );
  }

  checkTiming(
    checks,
    benchmarks,
    /buildAuditPrompt$/,
    'buildAuditPrompt',
    BUDGETS.promptBuildMaxMs,
  );

  for (const n of [1, 5, 25, 100]) {
    checkTiming(
      checks,
      benchmarks,
      new RegExp(`buildPRContextString ${n} files$`),
      `buildPRContextString (${n} files)`,
      BUDGETS.contextBuildMaxMs,
    );
    checkTiming(
      checks,
      benchmarks,
      new RegExp(`buildPRContextString ${n} files tokenBudget$`),
      `buildPRContextString (${n} files, token budget)`,
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

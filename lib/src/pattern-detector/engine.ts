import * as core from '@actions/core';
import type { LearningStore } from '../learning/store.js';
import { Logger } from '../utils/logger.js';
import { clusterFindings } from './cluster.js';

const NON_ALPHANUMERIC_REGEX = /[^a-z0-9]+/g;

export interface DiscoveredPattern {
  patternKey: string;
  messages: string[];
  frequency: number;
  fileTypes: string[];
}

export interface PatternDetectorOptions {
  windowSize?: number;
  sinceDays?: number;
}

export class PatternDetector {
  private options: PatternDetectorOptions;

  constructor(
    private store: LearningStore,
    options: PatternDetectorOptions = {},
  ) {
    this.options = {
      windowSize: options.windowSize ?? 100,
      sinceDays: options.sinceDays,
    };
  }

  async discover(minFrequency: number): Promise<DiscoveredPattern[]> {
    const { windowSize, sinceDays } = this.options;

    let findings: { message: string; file?: string }[];
    try {
      findings = await this.store.getFindingMessages(windowSize, sinceDays);
    } catch (err) {
      const logger = new Logger('PatternDetector');
      logger.warn('Failed to get finding messages', err);
      return [];
    }
    if (findings.length === 0) return [];

    // Count actual frequencies from raw findings
    const freqMap = new Map<string, number>();
    for (const f of findings) {
      if (f.message) freqMap.set(f.message, (freqMap.get(f.message) || 0) + 1);
    }

    // Deduplicate messages for clustering to reduce O(N^2) complexity
    const uniqueMessages = [...new Set(findings.map((f) => f.message).filter(Boolean))];
    if (uniqueMessages.length === 0) return [];

    const clusters = clusterFindings(uniqueMessages, 0.3);

    // Handle frequent messages that didn't cluster (single-message patterns)
    const clusteredMsgs = new Set(clusters.flatMap((c) => c.messages));
    for (const msg of uniqueMessages) {
      if (!clusteredMsgs.has(msg) && (freqMap.get(msg) || 0) >= minFrequency) {
        clusters.push({ centroid: msg, messages: [msg] });
      }
    }

    const patterns: DiscoveredPattern[] = [];

    for (const cluster of clusters) {
      // Count total frequency across all messages in the cluster
      let totalFrequency = 0;
      for (const msg of cluster.messages) {
        totalFrequency += freqMap.get(msg) || 0;
      }
      if (totalFrequency < minFrequency) continue;

      const messageSet = new Set(cluster.messages);
      const relatedFindings = findings.filter((f) => messageSet.has(f.message));

      const fileTypeSet = new Set<string>();
      for (const f of relatedFindings) {
        if (!f.file) continue;
        const ext = f.file.split('.').pop();
        if (ext) fileTypeSet.add(`.${ext}`);
      }
      const fileTypes = Array.from(fileTypeSet);

      const patternKey = cluster.centroid
        .toLowerCase()
        .replace(NON_ALPHANUMERIC_REGEX, '-')
        .slice(0, 60);

      patterns.push({
        patternKey,
        messages: cluster.messages,
        frequency: totalFrequency,
        fileTypes,
      });
    }

    try {
      await this.store.recordPatterns(
        patterns.map((p) => ({
          patternKey: p.patternKey,
          messageCluster: p.messages,
          frequency: p.frequency,
          fileTypes: p.fileTypes,
        })),
      );
    } catch (err) {
      core.warning(`Failed to record patterns: ${err instanceof Error ? err.message : err}`);
    }

    return patterns;
  }
}

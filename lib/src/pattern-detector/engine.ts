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

export class PatternDetector {
  constructor(private store: LearningStore) {}

  async discover(minFrequency: number): Promise<DiscoveredPattern[]> {
    let findings: { message: string; file?: string }[];
    try {
      findings = await this.store.getFindingMessages(100);
    } catch (err) {
      const logger = new Logger('PatternDetector');
      logger.warn('Failed to get finding messages', err);
      return [];
    }
    if (findings.length === 0) return [];

    const messages = findings.map((f) => f.message).filter(Boolean);
    const clusters = clusterFindings(messages, 0.3);

    const patterns: DiscoveredPattern[] = [];

    for (const cluster of clusters) {
      if (cluster.messages.length < minFrequency) continue;

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
        frequency: cluster.messages.length,
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

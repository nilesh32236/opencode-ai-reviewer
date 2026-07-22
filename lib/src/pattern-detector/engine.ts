import * as core from '@actions/core';
import type { LearningStore } from '../learning/store.js';
import { Logger } from '../utils/logger.js';
import { clusterFindings } from './cluster.js';

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

      const relatedFindings = findings.filter((f) => cluster.messages.some((m) => m === f.message));

      const fileTypes = [
        ...new Set(
          relatedFindings
            .map((f) => {
              const file = f.file;
              if (!file) return '';
              const ext = file.split('.').pop();
              return ext ? `.${ext}` : '';
            })
            .filter(Boolean),
        ),
      ];

      const patternKey = cluster.centroid
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
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

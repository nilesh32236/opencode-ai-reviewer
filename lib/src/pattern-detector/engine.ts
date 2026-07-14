import { LearningStore } from '../learning/store.js';
import { clusterFindings } from './cluster.js';

export interface DiscoveredPattern {
  patternKey: string;
  messages: string[];
  frequency: number;
  fileTypes: string[];
}

export class PatternDetector {
  constructor(private store: LearningStore) {}

  discover(minFrequency: number): DiscoveredPattern[] {
    const findings = this.store.getFindings(undefined, 100);
    if (findings.length === 0) return [];

    const messages = findings.map((f) => f.message as string).filter(Boolean);
    const clusters = clusterFindings(messages, 0.3);

    const patterns: DiscoveredPattern[] = [];

    for (const cluster of clusters) {
      if (cluster.messages.length < minFrequency) continue;

      const relatedFindings = findings.filter((f) =>
        cluster.messages.some((m) => m === f.message),
      );

      const fileTypes = [
        ...new Set(
          relatedFindings
            .map((f) => {
              const file = f.file as string;
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

      this.store.recordPattern({
        patternKey,
        messageCluster: cluster.messages,
        frequency: cluster.messages.length,
        fileTypes,
      });
    }

    return patterns;
  }
}

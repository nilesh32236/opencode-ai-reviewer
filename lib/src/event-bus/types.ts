import type { GitHubEvent, Subscriber } from '../types/index.js';

export interface EventBusConfig {
  name: string;
}

export type { GitHubEvent, Subscriber };

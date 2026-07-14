import type { GitHubEvent, Subscriber } from '../types/index.js';

export interface EventBusConfig {
  name: string;
}

export { GitHubEvent, Subscriber };

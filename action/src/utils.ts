import { sanitizeString } from '@opencode-pr-agent/lib';

export const sanitize = (message: string): string => sanitizeString(message);

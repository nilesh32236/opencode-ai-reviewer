/**
 * Single source of truth for the platform package version, kept in sync with
 * `platform/package.json`. Referenced by the service identity endpoint so it
 * never reports a stale hardcoded value.
 */

import pkg from '../package.json';

/** Version of the platform package (from package.json). */
export const PLATFORM_VERSION: string = (pkg as { version?: string }).version ?? '0.0.0';

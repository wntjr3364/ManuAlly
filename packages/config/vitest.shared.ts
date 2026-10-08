import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IGNORE_DIRS } from './test-patterns.ts';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const commonExclude = [...IGNORE_DIRS.map((d) => `**/${d}/**`), 'spikes/**'];

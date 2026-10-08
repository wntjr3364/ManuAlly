import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const commonExclude = ['**/node_modules/**', 'spikes/**', '**/dist/**'];

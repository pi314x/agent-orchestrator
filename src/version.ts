import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolves from both src/ (tsx) and dist/ — package.json is one level up in either.
const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');

export const VERSION: string = (JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version: string })
  .version;

export const SERVER_NAME = 'agent-orchestrator';

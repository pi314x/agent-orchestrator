import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const connectorsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'connectors');

/**
 * Every file in connectors/ is a copy-paste template: it must parse, must
 * name the orchestrator entry, and must still carry the absolute-path
 * placeholder so nobody connects to nothing by accident. The README table
 * must list every file, or the file is undiscoverable.
 */
describe('connectors', () => {
  const files = readdirSync(connectorsDir).filter(name => name !== 'README.md');

  it('ships a connector for every documented host', async () => {
    expect(files.length).toBeGreaterThan(0);
    const readme = readFileSync(join(connectorsDir, 'README.md'), 'utf8');
    for (const file of files) {
      expect(readme).toContain(file);
    }
  });

  it.each(files)('%s parses and points at the built server', async file => {
    const raw = readFileSync(join(connectorsDir, file), 'utf8');
    // Still a template: the placeholder must survive, never a real local path.
    expect(raw).toContain('/absolute/path/to/agent-orchestrator');

    if (file.endsWith('.json')) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(JSON.stringify(parsed)).toContain('orchestrator');
      expect(JSON.stringify(parsed)).toContain('dist/index.js');
    } else {
      expect(raw).toContain('orchestrator');
      expect(raw).toContain('dist/index.js');
    }
  });

  it('opencode.json uses the local type with a command array', async () => {
    const parsed = JSON.parse(readFileSync(join(connectorsDir, 'opencode.json'), 'utf8')) as {
      mcp?: Record<string, { type?: string; command?: unknown; enabled?: boolean }>;
    };
    const entry = parsed.mcp?.['orchestrator'];
    expect(entry?.type).toBe('local');
    expect((entry?.command as string[]).join(' ')).toContain('dist/index.js');
    expect(entry?.enabled).toBe(true);
  });
});

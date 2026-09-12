import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAgentFiles, parseAgentFile } from '../../src/core/agent-files.js';
import { AgentRegistry } from '../../src/core/registry.js';
import { migratedDb } from '../helpers.js';

const dirs: string[] = [];

function tempAgentsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'orch-agents-'));
  dirs.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents);
  }
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('parseAgentFile', () => {
  it('reads frontmatter and uses the body as instructions', () => {
    const definition = parseAgentFile(
      ['---', 'name: reviewer', 'role: reviewer', 'runner: mock', '---', '', 'Review carefully.'].join('\n'),
      '/agents/reviewer.md'
    );

    expect(definition).toMatchObject({
      name: 'reviewer',
      role: 'reviewer',
      runner: 'mock',
      instructions: 'Review carefully.'
    });
  });

  it('falls back to the filename when no name is given', () => {
    const definition = parseAgentFile('Just instructions.', '/agents/planner.md');
    expect(definition.name).toBe('planner');
  });

  it('parses a comma-separated tools list', () => {
    const definition = parseAgentFile(
      ['---', 'tools: read_file, write_file', '---', 'body'].join('\n'),
      '/a/x.md'
    );
    expect(definition.toolGrants).toEqual(['read_file', 'write_file']);
  });

  it('rejects a file with no instructions', () => {
    expect(() => parseAgentFile(['---', 'name: empty', '---', ''].join('\n'), '/a/empty.md')).toThrow(
      /no instructions/
    );
  });

  it('rejects an unknown runner', () => {
    expect(() => parseAgentFile(['---', 'runner: telepathy', '---', 'body'].join('\n'), '/a/x.md')).toThrow(
      /unknown runner/
    );
  });
});

describe('loadAgentFiles', () => {
  it('returns nothing when the directory does not exist', () => {
    expect(loadAgentFiles('/definitely/not/here')).toEqual([]);
  });

  it('loads every markdown file and ignores the rest', () => {
    const dir = tempAgentsDir({
      'a.md': '---\nname: a\n---\nA instructions',
      'b.md': '---\nname: b\n---\nB instructions',
      'notes.txt': 'ignored'
    });

    expect(loadAgentFiles(dir).map(d => d.name)).toEqual(['a', 'b']);
  });
});

describe('AgentRegistry.syncFromFiles', () => {
  it('creates agents on first sync and makes them routable', () => {
    const db = migratedDb();
    const agents = new AgentRegistry(db);
    const dir = tempAgentsDir({
      'sec.md': '---\nname: sec\nrole: reviewer\nrunner: mock\n---\nReview security.'
    });

    const result = agents.syncFromFiles(loadAgentFiles(dir));

    expect(result.created).toEqual(['sec']);
    expect(agents.findByName('sec')?.source).toBe('file');
    expect(agents.findBySkill('reviewer', { ownerId: '', isAdmin: true })?.name).toBe('sec');
    db.close();
  });

  it('applies an edit on the next sync instead of duplicating', () => {
    const db = migratedDb();
    const agents = new AgentRegistry(db);

    agents.syncFromFiles(loadAgentFiles(tempAgentsDir({ 'x.md': '---\nname: x\n---\nOriginal.' })));
    const result = agents.syncFromFiles(
      loadAgentFiles(tempAgentsDir({ 'x.md': '---\nname: x\n---\nRevised.' }))
    );

    expect(result.updated).toEqual(['x']);
    expect(agents.list().agents).toHaveLength(1);
    expect(agents.findByName('x')?.instructions).toBe('Revised.');
    db.close();
  });

  it('withdraws an agent whose file was deleted', () => {
    const db = migratedDb();
    const agents = new AgentRegistry(db);

    agents.syncFromFiles(loadAgentFiles(tempAgentsDir({ 'gone.md': '---\nname: gone\n---\nBye.' })));
    const result = agents.syncFromFiles([]);

    expect(result.removed).toEqual(['gone']);
    expect(agents.findByName('gone')).toBeUndefined();
    db.close();
  });

  it('never touches agents created through the API', () => {
    const db = migratedDb();
    const agents = new AgentRegistry(db);
    agents.create({ name: 'api-made', instructions: 'stay' });

    agents.syncFromFiles([]);

    expect(agents.findByName('api-made')?.source).toBe('api');
    db.close();
  });
});

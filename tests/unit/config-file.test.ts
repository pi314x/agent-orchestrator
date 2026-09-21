import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyDeclarativeConfig, loadDeclarativeConfigFile } from '../../src/config-file.js';
import { closeServices, testServices } from '../helpers.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-config-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadDeclarativeConfigFile', () => {
  it('skips a missing default file', async () => {
    await expect(loadDeclarativeConfigFile(undefined, dir)).resolves.toEqual({ path: undefined, config: {} });
  });

  it('fails a missing explicit file', async () => {
    await expect(loadDeclarativeConfigFile(join(dir, 'missing.json'))).rejects.toThrow(/cannot be read/);
  });

  it('rejects invalid JSON and unknown keys', async () => {
    writeFileSync(join(dir, 'bad.json'), '{oops');
    await expect(loadDeclarativeConfigFile(join(dir, 'bad.json'))).rejects.toThrow(/not valid JSON/);

    writeFileSync(join(dir, 'typo.json'), JSON.stringify({ templatez: [] }));
    await expect(loadDeclarativeConfigFile(join(dir, 'typo.json'))).rejects.toThrow(/templatez/);
  });
});

describe('applyDeclarativeConfig', () => {
  it('applies every section and re-applies idempotently', async () => {
    const services = await testServices();
    const file = join(dir, 'orchestrator.config.json');
    writeFileSync(
      file,
      JSON.stringify({
        templates: [{ name: 'greeter', role: 'writer', description: 'greets', instructions: 'Say hi.' }],
        toolservers: [{ name: 'files', transport: { type: 'stdio', command: 'node', args: ['-e', '1'] } }],
        presets: [{ name: 'reader', grants: ['files'] }],
        schedules: [{ name: 'nightly', cron: '0 2 * * *', instruction: 'sweep', template: 'coder' }],
        budgets: [{ scope: 'global', maxCalls: 100 }]
      })
    );

    const { config, path } = await loadDeclarativeConfigFile(file);
    expect(path).toBe(file);

    const first = await applyDeclarativeConfig(services, config);
    expect(first).toEqual({ templates: 1, toolservers: 1, presets: 1, schedules: 1, budgets: 1 });
    expect(await services.templates.resolve('greeter')).toBeDefined();
    expect(await services.proxy.get('files')).toBeDefined();
    expect((await services.presets.list()).map(preset => preset.name)).toEqual(['reader']);
    expect((await services.schedules.list(10, '')).map(schedule => schedule.name)).toEqual(['nightly']);
    expect(await services.budgets.get('global')).toMatchObject({ maxCalls: 100 });

    const second = await applyDeclarativeConfig(services, config);
    expect(second).toEqual(first);
    expect((await services.schedules.list(10, '')).map(schedule => schedule.scheduleId)).toHaveLength(1);
    await closeServices(services);
  });

  it('fails fast on an unknown schedule template', async () => {
    const services = await testServices();
    await expect(
      applyDeclarativeConfig(services, {
        schedules: [{ name: 'bad', cron: '* * * * *', instruction: 'x', template: 'ghost' }]
      })
    ).rejects.toThrow(/unknown template/);
    await closeServices(services);
  });
});

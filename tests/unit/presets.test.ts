import { describe, expect, it } from 'vitest';
import { GrantPresetStore } from '../../src/core/grants.js';
import { migratedDb } from '../helpers.js';

describe('GrantPresetStore', () => {
  it('saves, reads back and lists presets', async () => {
    const db = await migratedDb();
    const presets = new GrantPresetStore(db);

    await presets.save('reader', ['files', 'files/read_file']);
    expect(await presets.get('reader')).toMatchObject({ name: 'reader', grants: ['files', 'files/read_file'] });
    expect((await presets.list()).map(p => p.name)).toEqual(['reader']);
    expect(await presets.get('ghost')).toBeUndefined();
    await db.close();
  });

  it('dedupes grants and overwrites on re-save', async () => {
    const db = await migratedDb();
    const presets = new GrantPresetStore(db);

    await presets.save('reader', ['files', 'files']);
    expect((await presets.get('reader'))?.grants).toEqual(['files']);
    await presets.save('reader', ['docs']);
    expect((await presets.get('reader'))?.grants).toEqual(['docs']);
    await db.close();
  });

  it('rejects malformed grants', async () => {
    const db = await migratedDb();
    const presets = new GrantPresetStore(db);

    await expect(presets.save('bad', ['not a grant!'])).rejects.toThrow(/must be "server" or "server\/tool"/);
    await expect(presets.save('bad', ['a/b/c'])).rejects.toThrow(/must be "server" or "server\/tool"/);
    await db.close();
  });
});

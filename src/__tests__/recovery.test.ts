import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ShardWorker } from '../shard_worker';
import { ShardWAL } from '../wal';

const dirs: string[] = [];
const atom = (value: string) => `v1.other.${value}`;

function tempDbBase(label: string): string {
    const base = mkdtempSync(join(tmpdir(), `mmpm-recovery-${label}-`));
    dirs.push(base);
    return base;
}

afterAll(() => {
    while (dirs.length > 0) {
        const dir = dirs.pop()!;
        try { rmSync(dir, { recursive: true, force: true }); } catch { }
    }
});

describe('Crash recovery (Story 8.2)', () => {
    it('replays uncommitted WAL ADD entries after simulated crash and preserves data', async () => {
        const base = tempDbBase('add');
        const shardPath = join(base, 'shard_0');

        const firstBoot = new ShardWorker([atom('A'), atom('B')], shardPath);
        await firstBoot.init();
        await firstBoot.close();

        const wal = new ShardWAL(`${shardPath}.wal`);
        await wal.open();
        await wal.writeAdd(atom('CrashOnlyAtom'));
        await wal.close();

        const recovered = new ShardWorker([atom('A'), atom('B')], shardPath);
        await recovered.init();

        const report = await recovered.access(atom('CrashOnlyAtom'));
        expect(report.hash).toMatch(/^[a-f0-9]{64}$/);
        expect(report.proof.root).toMatch(/^[a-f0-9]{64}$/);

        await recovered.close();

        const walAfterRecovery = new ShardWAL(`${shardPath}.wal`);
        const uncommitted = await walAfterRecovery.readUncommitted();
        expect(uncommitted).toEqual([]);
    });

    it('replays uncommitted WAL TOMBSTONE entries after simulated crash', async () => {
        const base = tempDbBase('tomb');
        const shardPath = join(base, 'shard_0');

        const firstBoot = new ShardWorker([atom('X'), atom('Y'), atom('Z')], shardPath);
        await firstBoot.init();
        await firstBoot.close();

        const wal = new ShardWAL(`${shardPath}.wal`);
        await wal.open();
        await wal.writeTombstone(1); // index of v1.other.Y in seed order
        await wal.close();

        const recovered = new ShardWorker([atom('X'), atom('Y'), atom('Z')], shardPath);
        await recovered.init();

        await expect(recovered.access(atom('Y'))).rejects.toThrow(/tombstoned/i);
        await expect(recovered.access(atom('X'))).resolves.toBeDefined();
        await expect(recovered.access(atom('Z'))).resolves.toBeDefined();

        await recovered.close();

        const walAfterRecovery = new ShardWAL(`${shardPath}.wal`);
        const uncommitted = await walAfterRecovery.readUncommitted();
        expect(uncommitted).toEqual([]);
    });
});

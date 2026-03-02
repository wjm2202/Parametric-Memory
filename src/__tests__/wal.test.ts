import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ShardWAL } from '../wal';
import { mkdtempSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function tempWal(): { wal: ShardWAL; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'mmpm-wal-test-'));
    const wal = new ShardWAL(join(dir, 'test.wal'));
    return {
        wal,
        cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { } },
    };
}

describe('ShardWAL', () => {
    it('readUncommitted returns [] when file does not exist', async () => {
        const { wal, cleanup } = tempWal();
        const entries = await wal.readUncommitted();
        expect(entries).toEqual([]);
        cleanup();
    });

    it('writeAdd produces a readable ADD entry', async () => {
        const { wal, cleanup } = tempWal();
        await wal.open();
        await wal.writeAdd('test_atom');
        const entries = await wal.readUncommitted();
        expect(entries).toHaveLength(1);
        expect(entries[0].op).toBe('ADD');
        expect(entries[0].data).toBe('test_atom');
        await wal.close();
        cleanup();
    });

    it('writeTombstone produces a readable TOMBSTONE entry', async () => {
        const { wal, cleanup } = tempWal();
        await wal.open();
        await wal.writeTombstone(3);
        const entries = await wal.readUncommitted();
        expect(entries).toHaveLength(1);
        expect(entries[0].op).toBe('TOMBSTONE');
        expect(entries[0].index).toBe(3);
        await wal.close();
        cleanup();
    });

    it('writeCommit produces a COMMIT entry', async () => {
        const { wal, cleanup } = tempWal();
        await wal.open();
        await wal.writeAdd('atom_a');
        await wal.writeCommit();
        // After a commit, readUncommitted returns nothing
        const entries = await wal.readUncommitted();
        expect(entries).toEqual([]);
        await wal.close();
        cleanup();
    });

    it('entries written before COMMIT are excluded from readUncommitted', async () => {
        const { wal, cleanup } = tempWal();
        await wal.open();
        await wal.writeAdd('committed_atom');
        await wal.writeCommit();
        await wal.writeAdd('pending_atom'); // after commit — not yet committed
        const entries = await wal.readUncommitted();
        expect(entries).toHaveLength(1);
        expect(entries[0].data).toBe('pending_atom');
        await wal.close();
        cleanup();
    });

    it('truncate clears all entries', async () => {
        const { wal, cleanup } = tempWal();
        await wal.open();
        await wal.writeAdd('atom_a');
        await wal.writeAdd('atom_b');
        await wal.truncate();
        const entries = await wal.readUncommitted();
        expect(entries).toEqual([]);
        await wal.close();
        cleanup();
    });

    it('checksum is validated — corrupted entries are skipped', async () => {
        const { wal, cleanup } = tempWal();
        await wal.open();
        await wal.writeAdd('good_atom');
        // Manually append a corrupted line
        const { promises: fsp } = await import('fs');
        const filePath = join(
            (wal as any).filePath.split('/').slice(0, -1).join('/'),
            (wal as any).filePath.split('/').pop()
        );
        await fsp.appendFile((wal as any).filePath, '{"seq":99,"ts":0,"op":"ADD","data":"evil","ck":"00000000"}\n');
        const entries = await wal.readUncommitted();
        // Only the valid entry should appear
        expect(entries).toHaveLength(1);
        expect(entries[0].data).toBe('good_atom');
        await wal.close();
        cleanup();
    });

    it('multiple ADD entries survive across open/close cycles', async () => {
        const { wal, cleanup } = tempWal();
        await wal.open();
        await wal.writeAdd('atom_1');
        await wal.writeAdd('atom_2');
        await wal.close();
        // Re-open and read
        await wal.open();
        await wal.writeAdd('atom_3');
        const entries = await wal.readUncommitted();
        expect(entries.map(e => e.data)).toEqual(['atom_1', 'atom_2', 'atom_3']);
        await wal.close();
        cleanup();
    });

    it('seq numbers are monotonically increasing', async () => {
        const { wal, cleanup } = tempWal();
        await wal.open();
        await wal.writeAdd('a');
        await wal.writeTombstone(0);
        await wal.writeAdd('b');
        const entries = await wal.readUncommitted();
        expect(entries[0].seq).toBe(1);
        expect(entries[1].seq).toBe(2);
        expect(entries[2].seq).toBe(3);
        await wal.close();
        cleanup();
    });

    it('compacts WAL when size threshold is exceeded', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mmpm-wal-compact-test-'));
        const walPath = join(dir, 'test.wal');
        const wal = new ShardWAL(walPath, { compactThresholdBytes: 1 });

        await wal.open();
        await wal.writeAdd('atom_a', 5);
        await wal.writeTombstone(5); // supersedes the uncommitted add

        const entries = await wal.readUncommitted();
        expect(entries).toEqual([]);

        const fileSize = statSync(walPath).size;
        expect(fileSize).toBeLessThan(32);

        await wal.close();
        try { rmSync(dir, { recursive: true, force: true }); } catch { }
    });

    it('compaction drops duplicated uncommitted tombstones for the same index', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mmpm-wal-compact-test-'));
        const walPath = join(dir, 'test.wal');
        const wal = new ShardWAL(walPath, { compactThresholdBytes: 1 });

        await wal.open();
        await wal.writeTombstone(7);
        await wal.writeTombstone(7);
        await wal.writeTombstone(7);

        const entries = await wal.readUncommitted();
        expect(entries).toHaveLength(1);
        expect(entries[0].op).toBe('TOMBSTONE');
        expect(entries[0].index).toBe(7);

        await wal.close();
        try { rmSync(dir, { recursive: true, force: true }); } catch { }
    });
});

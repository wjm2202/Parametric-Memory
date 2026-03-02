import { describe, it, expect } from 'vitest';
import { EpochManager } from '../epoch';

describe('EpochManager', () => {
    it('starts at epoch 0 with no readers', () => {
        const em = new EpochManager();
        expect(em.currentEpoch).toBe(0);
        expect(em.getActiveReaders()).toBe(0);
        expect(em.isCommitting).toBe(false);
    });

    it('beginRead/endRead tracks reader count', () => {
        const em = new EpochManager();
        const t1 = em.beginRead();
        const t2 = em.beginRead();
        expect(em.getActiveReaders(0)).toBe(2);

        em.endRead(t1);
        expect(em.getActiveReaders(0)).toBe(1);

        em.endRead(t2);
        expect(em.getActiveReaders(0)).toBe(0);
    });

    it('beginCommit bumps epoch and waits for old readers to drain', async () => {
        const em = new EpochManager();

        // Start a reader on epoch 0
        const ticket = em.beginRead();
        expect(em.currentEpoch).toBe(0);

        // Start commit — should bump epoch immediately
        let commitResolved = false;
        const commitPromise = em.beginCommit().then(oldEpoch => {
            commitResolved = true;
            return oldEpoch;
        });

        // New epoch is 1
        expect(em.currentEpoch).toBe(1);
        // But commit hasn't resolved yet — old reader still active
        await new Promise(r => setTimeout(r, 10));
        expect(commitResolved).toBe(false);

        // Release the old reader
        em.endRead(ticket);

        // Now commit should resolve
        const oldEpoch = await commitPromise;
        expect(oldEpoch).toBe(0);
        expect(commitResolved).toBe(true);

        em.endCommit();
    });

    it('commit resolves immediately when no old readers exist', async () => {
        const em = new EpochManager();
        const oldEpoch = await em.beginCommit();
        expect(oldEpoch).toBe(0);
        expect(em.currentEpoch).toBe(1);
        em.endCommit();
    });

    it('new readers during commit go to the new epoch', async () => {
        const em = new EpochManager();
        await em.beginCommit(); // epoch 0 → 1

        const ticket = em.beginRead();
        expect(ticket.epoch).toBe(1);
        expect(em.getActiveReaders(1)).toBe(1);
        expect(em.getActiveReaders(0)).toBe(0);

        em.endRead(ticket);
        em.endCommit();
    });

    it('prevents concurrent commits', async () => {
        const em = new EpochManager();
        await em.beginCommit();

        await expect(em.beginCommit()).rejects.toThrow(/already in progress/);

        em.endCommit();
    });

    it('multiple sequential commits work correctly', async () => {
        const em = new EpochManager();

        await em.beginCommit();
        em.endCommit();
        expect(em.currentEpoch).toBe(1);

        await em.beginCommit();
        em.endCommit();
        expect(em.currentEpoch).toBe(2);

        await em.beginCommit();
        em.endCommit();
        expect(em.currentEpoch).toBe(3);
    });

    it('getStatus returns comprehensive status', async () => {
        const em = new EpochManager();
        const t1 = em.beginRead();
        const t2 = em.beginRead();

        const status = em.getStatus();
        expect(status.currentEpoch).toBe(0);
        expect(status.isCommitting).toBe(false);
        expect(status.activeReadersByEpoch[0]).toBe(2);

        em.endRead(t1);
        em.endRead(t2);
    });

    it('handles readers across multiple epochs correctly', async () => {
        const em = new EpochManager();

        // Reader on epoch 0
        const t0 = em.beginRead();

        // Commit → epoch 1
        const commitPromise = em.beginCommit();
        em.endRead(t0);
        await commitPromise;
        em.endCommit();

        // Reader on epoch 1
        const t1 = em.beginRead();
        expect(t1.epoch).toBe(1);

        // Commit → epoch 2
        const commitPromise2 = em.beginCommit();
        em.endRead(t1);
        await commitPromise2;
        em.endCommit();

        expect(em.currentEpoch).toBe(2);
    });
});

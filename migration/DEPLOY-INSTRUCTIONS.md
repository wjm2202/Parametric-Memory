# MMPM Coordinated Migration — Jump Consistent Hash

**Date:** 2026-03-09
**Reason:** Router change from MD5 ring hash → SHA-256 Jump Consistent Hash
**Impact:** All atoms will be routed to different shards. Old shard data must be wiped.
**Safety:** Full backup saved to `migration/mmpm-backup-2026-03-09.json` (143 active atoms, 5 trained edges, 17 total weight)

## Pre-Migration Checklist

- [x] Atoms exported via MCP tools (152 total, 143 active, 9 tombstoned)
- [x] Markov weights captured (5 edges, 17 total weight)
- [x] Backup saved to local filesystem (not in memory)
- [ ] Deploy new code (steps below)
- [ ] Reimport atoms + retrain (Claude will do this via MCP after deploy)

## Deployment Steps (Run on the Droplet)

SSH into the droplet:

```bash
ssh root@170.64.198.144
```

Navigate to the repo:

```bash
cd ~/markov-merkle-memory
```

Pull the latest code:

```bash
git pull origin main
```

Stop the running stack (keeps volumes for now):

```bash
docker compose -f integrations/deploy/docker-compose.production.yml down
```

Remove the old shard data volume (atoms will be re-routed under new hash):

```bash
docker volume rm markov-merkle-memory_mmpm-data
```

> If the volume name differs, check with `docker volume ls | grep mmpm`.

Rebuild and start with new code:

```bash
docker compose -f integrations/deploy/docker-compose.production.yml up -d --build
```

Wait for health check to pass:

```bash
docker compose -f integrations/deploy/docker-compose.production.yml ps
```

Verify the server is responding:

```bash
curl -s https://mmpm.co.nz/health | head -20
```

## After Deployment

Tell Claude: **"the deploy is done, reimport the atoms"**

Claude will then:
1. Re-add all 143 active atoms via MCP `memory_atoms_add` (in batches)
2. Commit them via `memory_commit`
3. Replay all 5 trained edges with correct weights via `memory_train`
4. Commit again
5. Verify health + atom count

## Training Edges to Replay

| # | From | To | Weight |
|---|------|----|--------|
| 1 | v1.procedure.user_corrected_file_first... | v1.procedure.store_memory_before... | 6 |
| 2 | v1.procedure.store_memory_before... | v1.procedure.name_atoms_with_keywords... | 3 |
| 3 | v1.procedure.never_train_new_atoms... | v1.procedure.use_3_training_passes... | 2 |
| 4 | v1.procedure.check_memory_search... | v1.procedure.store_findings_progressively... | 3 |
| 5 | v1.procedure.store_findings_progressively... | v1.event.research_completed... | 3 |

Total: 17 train calls across 5 edges.

## Rollback

If something goes wrong, the backup file contains all atoms and weights. The migration script (`scripts/migrate.ts`) can also be run directly from any machine with network access to the server.

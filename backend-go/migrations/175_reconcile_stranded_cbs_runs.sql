-- 175_reconcile_stranded_cbs_runs.sql
--
-- 60 cbs_sync_runs rows have sat in 'running' since as far back as 31 July.
--
-- A sync run is marked 'running' when it starts and updated when it ends. If the
-- process dies in between — which happens on every deploy restart, and this
-- server is restarted often — nothing ever closes the row. It stays 'running'
-- forever, so anything asking "is a sync in flight?" is answered wrongly, and the
-- Sync & Workers hub shows a run that ended weeks ago as still going.
--
-- A run that started before the current process booted cannot still be running.
-- These are marked 'interrupted' — distinct from 'error', because the sync did
-- not fail, it was killed. Idempotent: it selects on the state it removes.

UPDATE app.cbs_sync_runs
   SET status = 'interrupted',
       finished_at = COALESCE(finished_at, started_at),
       error = COALESCE(NULLIF(error,''),
                        'Process restarted while this run was in flight; never completed')
 WHERE status = 'running'
   -- Well beyond the 5-minute context timeout the sync runs under, so a genuinely
   -- in-flight run is never touched.
   AND started_at < NOW() - interval '30 minutes';

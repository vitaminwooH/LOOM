-- ============================================================================
-- Loom — 0008: daily canvas-sync schedule (pg_cron + pg_net + Vault).
--
-- Safety net alongside the /loom-sync slash command: every day at 09:00 KST
-- (= 00:00 UTC) the canvas is synced append-only, and the result lands in
-- the Slack channel (the function's notify path).
--
-- PREREQUISITE (run once, by hand, BEFORE this file — the secret value must
-- never appear in the repo, so it is not here):
--
--   select vault.create_secret('<CANVAS_SYNC_SECRET 값>', 'canvas_sync_secret');
--
-- The cron job reads the secret from Vault by name at run time; rotating the
-- secret is one vault.update_secret away, no re-scheduling needed.
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'canvas-sync-daily',
  '0 0 * * *',  -- 00:00 UTC = 09:00 KST
  $$
  select net.http_post(
    url := 'https://gfyfdfdxidiuzdiiehea.supabase.co/functions/v1/canvas-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-canvas-sync-secret',
        (select decrypted_secret from vault.decrypted_secrets where name = 'canvas_sync_secret')
    ),
    -- notify=true → the function acks immediately (202) and runs the sync in
    -- the background, so pg_net's short timeout never truncates the work.
    -- Scheduled runs are silent in Slack; the outcome lands in the function
    -- log (Dashboard → Edge Functions → canvas-sync → Logs).
    body := '{"mode":"sync","notify":true}'::jsonb,
    timeout_milliseconds := 15000
  );
  $$
);

-- ============================================================================
-- Operations (run as needed; kept here as the reference):
--
-- Did it run?  (one row per firing, status + return message)
--   select jobid, status, return_message, start_time
--   from cron.job_run_details
--   where jobid = (select jobid from cron.job where jobname = 'canvas-sync-daily')
--   order by start_time desc limit 10;
--
-- What did the function answer?  (pg_net keeps recent HTTP responses)
--   select id, status_code, content, created
--   from net._http_response
--   order by created desc limit 5;
--
-- Unschedule:
--   select cron.unschedule('canvas-sync-daily');
--
-- Change the time (e.g. 08:00 KST = 23:00 UTC — note the previous day):
--   select cron.alter_job(
--     (select jobid from cron.job where jobname = 'canvas-sync-daily'),
--     schedule := '0 23 * * *');
--
-- Rotate the secret (after changing CANVAS_SYNC_SECRET in Edge Function
-- Secrets to the same new value):
--   select vault.update_secret(
--     (select id from vault.secrets where name = 'canvas_sync_secret'),
--     '<새 값>');
-- ============================================================================

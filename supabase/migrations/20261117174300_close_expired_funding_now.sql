-- Records a statement Sulstice ran by hand in the SQL editor on 2026-11-17, so the repo holds every change made
-- to production. It was handed over in a Claude Code session as text, at 17:42 UTC, not as a file, which is why
-- no file held it until now (found in the review of #520: "close_expired_funding_now is [in production] too,
-- with no file anywhere").
--
-- WHAT RAN, under the audit label migration:close_expired_funding_now:
--     BEGIN;
--     SELECT public.set_actor('migration:close_expired_funding_now');
--     UPDATE public.funding_opportunities
--        SET status = 'closed', updated_at = now()
--      WHERE status <> 'closed' AND expiration_date IS NOT NULL AND expiration_date < CURRENT_DATE
--     RETURNING fon, expiration_date, status;
--     COMMIT;
-- WHY. 20261117160000_funding_call_expiration_dates had just given six funding calls their expiration date. Five
-- of those dates were already past, and the calls still said 'open' until the daily job would close them the
-- next morning (close-expired-funding-daily, 07:15 UTC, scheduled by 20260508185044). The statement is that
-- job's own rule, run at once instead of the next morning. It changed status and nothing else.
-- WHICH ROWS. As the data stood (the report of 20261117160000, pasted minutes earlier): RFA-RM-27-011 (expired
-- 2026-10-10), RFA-RM-27-012 and RFA-RM-27-013 (2026-10-20), RFA-RM-27-014 (2026-10-03) and NSF 26-526
-- (2026-10-23). Its own output was not kept; the audit trail has the rows and the time:
--     SELECT occurred_at, record_id, changed_fields FROM public.data_audit_log
--      WHERE actor_label = 'migration:close_expired_funding_now' ORDER BY occurred_at;
--
-- THIS FILE is the record, pinned to those five calls and to the day it ran. Nothing needs to apply it: it is
-- already live, and on production it changes nothing, because each of the five is closed. On a database built
-- from migrations alone the calls do not exist and it matches nothing.
SELECT public.set_actor('migration:record_close_expired_funding_now');

UPDATE public.funding_opportunities
   SET status = 'closed', updated_at = now()
 WHERE status <> 'closed'
   AND expiration_date IS NOT NULL AND expiration_date < DATE '2026-11-17'
   AND fon IN ('RFA-RM-27-011', 'RFA-RM-27-012', 'RFA-RM-27-013', 'RFA-RM-27-014', 'NSF 26-526');

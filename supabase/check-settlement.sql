-- Read-only diagnostics. Run after deployment and after the closed-browser test.
select jobname,schedule,active from cron.job where jobname='bitbase-contract-worker';
select last_run,now()-last_run as heartbeat_age,last_error from public.trade_worker_health;
select c.ref,c.user_id,c.symbol,c.status,c.starts_at,c.expires_at,c.entry_price,c.exit_price,c.amount,c.profit,c.payout,c.net,c.forced,c.settled_at
from public.trade_contracts c order by created desc limit 50;
select c.ref,q.phase,q.quote_at,q.attempts,q.error,q.retry_at from public.trade_quote_jobs q join public.trade_contracts c on c.id=q.contract_id
where q.error is not null order by q.quote_at;
-- Expected: zero rows. A canonical nonlegacy final trade has exactly one reserve and one payout.
select c.id,c.status,count(l.id) as ledger_entries from public.trade_contracts c left join public.trade_ledger l on l.contract_id=c.id
where not c.legacy and c.status in ('Won','Lost','Draw','Closed','Cancelled') group by c.id having count(l.id)<>2;
-- Expected: zero rows. Payout and net must match the reservation's amount.
select id,status,amount,payout,net from public.trade_contracts where status in ('Won','Lost','Draw','Closed','Cancelled') and net is distinct from payout-amount;
-- Expected: zero rows. forced must be true for exactly the Profit Mode accounts, and only on a win.
select id,status,forced from public.trade_contracts
where forced is distinct from (status='Won' and coalesce((select profit_mode from public.profiles p where p.id=trade_contracts.user_id),false));
-- Accounts the console has switched into Profit Mode. Turn one off here to stop forcing real contracts.
select id,name,email,cash,profit_mode,disabled from public.profiles where profit_mode order by created;
-- Review these old records manually; never guess their previous debit/payout.
select id,ref,user_id,symbol,amount,entry_price,expires_at from public.trade_contracts where status='Review';

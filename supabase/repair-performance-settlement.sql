-- Run AFTER repair-auth-realtime.sql. Existing balances are not recalculated.
-- Requires Supabase pg_cron and pg_net. No Edge Function or private API key.
begin;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

create table if not exists public.trade_contracts (
  id uuid primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  ref text not null,
  symbol text not null,
  direction text not null check(direction in ('UP','DOWN')),
  amount numeric(20,2) not null check(amount > 0),
  profit numeric(20,2) not null check(profit >= 0 and profit <= amount),
  duration integer not null check(duration > 0),
  starts_at timestamptz not null,
  expires_at timestamptz not null,
  entry_price numeric(30,10), exit_price numeric(30,10),
  status text not null default 'Active' check(status in ('Active','Won','Lost','Draw','Closed','Cancelled','Review')),
  payout numeric(20,2), net numeric(20,2), settled_at timestamptz,
  legacy boolean not null default false,
  position_row_id uuid not null default gen_random_uuid(),
  history_row_id uuid not null default gen_random_uuid(),
  created timestamptz not null default now(),
  check(expires_at > starts_at)
);
create index if not exists contracts_due_idx on public.trade_contracts(expires_at) where status='Active';
create index if not exists contracts_user_idx on public.trade_contracts(user_id,created desc);
alter table public.trade_contracts enable row level security;
drop policy if exists contracts_read on public.trade_contracts;
create policy contracts_read on public.trade_contracts for select to authenticated
 using(user_id=auth.uid() or public.is_admin());
grant select on public.trade_contracts to authenticated;
revoke insert,update,delete on public.trade_contracts from authenticated,anon;

create table if not exists public.trade_ledger (
  id bigint generated always as identity primary key,
  contract_id uuid not null references public.trade_contracts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  entry_type text not null check(entry_type in ('reserve','settlement','close')),
  delta numeric(20,2) not null,
  balance_after numeric(20,4) not null,
  created timestamptz not null default now(),
  unique(contract_id,entry_type)
);
create unique index if not exists trade_single_payout on public.trade_ledger(contract_id)
 where entry_type in ('settlement','close');
alter table public.trade_ledger enable row level security;
drop policy if exists trade_ledger_read on public.trade_ledger;
create policy trade_ledger_read on public.trade_ledger for select to authenticated
 using(user_id=auth.uid() or public.is_admin());
grant select on public.trade_ledger to authenticated;
revoke insert,update,delete on public.trade_ledger from authenticated,anon;

create table if not exists public.trade_quote_jobs (
  contract_id uuid not null references public.trade_contracts(id) on delete cascade,
  phase text not null check(phase in ('entry','exit')),
  quote_at timestamptz not null,
  request_id bigint, requested_at timestamptz,
  retry_at timestamptz not null default now(), attempts integer not null default 0,
  error text, primary key(contract_id,phase)
);
alter table public.trade_quote_jobs enable row level security;
revoke all on public.trade_quote_jobs from public,anon,authenticated;
create table if not exists public.trade_worker_health (
  id boolean primary key default true check(id), last_run timestamptz, last_error text
);
alter table public.trade_worker_health enable row level security;
revoke all on public.trade_worker_health from public,anon,authenticated;
insert into public.trade_worker_health(id,last_run) values(true,now()) on conflict(id) do nothing;

create or replace function public.bb_contract_json(c public.trade_contracts)
returns jsonb language sql stable set search_path=public,pg_temp as $$
 select jsonb_build_object('id',c.ref,'contractId',c.id,'uid',c.user_id,'userId',c.user_id,
   'pair',c.symbol||'/USDT','sym',c.symbol,'group','crypto','dir',c.direction,
   'amt',c.amount,'profit',c.profit,'dur',c.duration,'entryPrice',c.entry_price,
   'exitPrice',c.exit_price,'startTime',floor(extract(epoch from c.starts_at)*1000),
   'expiresAt',floor(extract(epoch from c.expires_at)*1000),'status',c.status,
   'mode','real','serverManaged',true,'legacy',c.legacy,'payout',c.payout,'net',c.net,
   'won',c.status='Won','refund',case when c.status='Closed' then c.payout else null end,
   'settledAt',floor(extract(epoch from c.settled_at)*1000));
$$;

-- Keep existing dashboard, history and admin APIs in sync, inside the same transaction.
create or replace function public.bb_publish_contract(c public.trade_contracts)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare d jsonb:=public.bb_contract_json(c);
begin
 insert into public.request_rows(id,kind,user_id,ref,status,amount,data,created)
 values(c.history_row_id,'trade',c.user_id,c.ref,c.status,c.amount,d,c.created)
 on conflict(id) do update set status=excluded.status,amount=excluded.amount,data=excluded.data;
 if c.status in ('Active','Review') then
   insert into public.request_rows(id,kind,user_id,ref,status,amount,data,created)
   values(c.position_row_id,'position',c.user_id,c.ref,c.status,c.amount,d,c.created)
   on conflict(id) do update set status=excluded.status,data=excluded.data;
 else
   delete from public.request_rows where id=c.position_row_id;
 end if;
end $$;

-- Idempotent placement: the client retains the same UUID until it receives an acknowledgement.
create or replace function public.bb_place_contract(p_id uuid,p_symbol text,p_direction text,p_amount numeric,p_duration integer)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare u uuid:=auth.uid(); c public.trade_contracts; p public.profiles; pct integer; bal numeric; st timestamptz;
begin
 if u is null then raise exception 'Sign in to place a trade'; end if;
 if p_id is null then raise exception 'A unique order ID is required'; end if;
 -- Serializes retries, simultaneous tabs, withdrawals and settlement on this account.
 select * into p from public.profiles where id=u for update;
 if not found or p.disabled then raise exception 'Account is unavailable'; end if;
 select * into c from public.trade_contracts where id=p_id;
 if found then
   if c.user_id<>u or c.symbol is distinct from p_symbol or c.direction is distinct from p_direction
      or c.amount is distinct from p_amount or c.duration is distinct from p_duration then
     raise exception 'Order ID already used with different details';
   end if;
   return public.bb_contract_json(c)||(select jsonb_build_object('balance',cash,'balanceVersion',updated) from public.profiles where id=u);
 end if;
 if not exists(select 1 from cron.job where jobname='bitbase-contract-worker' and active)
    or not exists(select 1 from public.trade_worker_health where last_run>now()-interval '60 seconds') then
   raise exception 'Automatic settlement is offline. Please try again shortly';
 end if;
 if p_symbol is null or p_symbol<>all(array['BTC','ETH','BNB','SOL','XRP','ADA','DOGE','AVAX','LINK','TRX','DOT','LTC']) then
   raise exception 'Automatic settlement is not configured for this pair. Use Demo';
 end if;
 if p_direction is null or p_direction not in ('UP','DOWN') then raise exception 'Invalid direction'; end if;
 if p_amount is null or p_amount::text in ('NaN','Infinity','-Infinity') or p_amount<=0 or p_amount<>round(p_amount,2) then
   raise exception 'Enter a positive amount with at most two decimal places';
 end if;
 pct:=case p_duration when 15 then 10 when 30 then 15 when 60 then 20 when 300 then 30
   when 900 then 40 when 1800 then 50 when 3600 then 60 when 7200 then 70 when 14400 then 80
   when 43200 then 90 when 86400 then 100 else null end;
 if pct is null then raise exception 'Unsupported duration'; end if;
 if p.cash<p_amount then raise exception 'Insufficient balance'; end if;
 if (select count(*) from public.trade_contracts where user_id=u and status='Active')>=30 then
   raise exception 'Please wait for an existing trade to settle';
 end if;
 -- Entry uses a future, whole-second boundary. The client cannot choose its price or clock.
 st:=date_trunc('second',clock_timestamp())+interval '2 seconds';
 insert into public.trade_contracts(id,user_id,ref,symbol,direction,amount,profit,duration,starts_at,expires_at)
 values(p_id,u,'T-'||left(p_id::text,13),p_symbol,p_direction,p_amount,round(p_amount*pct/100,2),p_duration,st,st+make_interval(secs=>p_duration))
 returning * into c;
 update public.profiles set cash=cash-p_amount,
   assets=jsonb_set(assets,'{USDT}',jsonb_build_object('balance',cash-p_amount,'qty',cash-p_amount),true)
 where id=u returning cash into bal;
 insert into public.trade_ledger(contract_id,user_id,entry_type,delta,balance_after) values(c.id,u,'reserve',-p_amount,bal);
 insert into public.trade_quote_jobs(contract_id,phase,quote_at) values(c.id,'entry',c.starts_at),(c.id,'exit',c.expires_at);
 perform public.bb_publish_contract(c);
 return public.bb_contract_json(c)||(select jsonb_build_object('balance',cash,'balanceVersion',updated) from public.profiles where id=u);
end $$;
revoke all on function public.bb_place_contract(uuid,text,text,numeric,integer) from public,anon;
grant execute on function public.bb_place_contract(uuid,text,text,numeric,integer) to authenticated;

create or replace function public.bb_close_contract(p_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.trade_contracts; bal numeric; u uuid:=auth.uid();
begin
 if u is null then raise exception 'Sign in to close a trade'; end if;
 -- All writers take the profile lock before the contract lock, avoiding lock-order deadlocks.
 perform 1 from public.profiles where id=u and not disabled for update;
 if not found then raise exception 'Account is unavailable'; end if;
 select * into c from public.trade_contracts where id=p_id and user_id=u for update;
 if not found then raise exception 'Trade not found'; end if;
 if c.status not in ('Active','Review') then return public.bb_contract_json(c)||(select jsonb_build_object('balance',cash,'balanceVersion',updated) from public.profiles where id=u); end if;
 if c.status='Review' then raise exception 'This legacy trade requires balance reconciliation'; end if;
 if clock_timestamp()>=c.expires_at then raise exception 'Trade expired; automatic settlement is pending'; end if;
 c.status:=case when c.entry_price is null then 'Cancelled' else 'Closed' end;
 c.payout:=case when c.entry_price is null then c.amount else round(c.amount*0.5,2) end;c.net:=c.payout-c.amount;c.settled_at:=clock_timestamp();
 update public.trade_contracts set status=c.status,payout=c.payout,net=c.net,settled_at=c.settled_at where id=c.id;
 update public.profiles set cash=cash+c.payout,
   assets=jsonb_set(assets,'{USDT}',jsonb_build_object('balance',cash+c.payout,'qty',cash+c.payout),true)
 where id=u returning cash into bal;
 insert into public.trade_ledger(contract_id,user_id,entry_type,delta,balance_after) values(c.id,u,'close',c.payout,bal);
 delete from public.trade_quote_jobs where contract_id=c.id;
 perform public.bb_publish_contract(c);
 return public.bb_contract_json(c)||(select jsonb_build_object('balance',cash,'balanceVersion',updated) from public.profiles where id=u);
end $$;
revoke all on function public.bb_close_contract(uuid) from public,anon;
grant execute on function public.bb_close_contract(uuid) to authenticated;

-- Private worker operation. No browser/admin API can supply a settlement price.
create or replace function public.bb_apply_contract_quote(p_id uuid,p_phase text,p_price numeric,p_quote_at timestamptz)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.trade_contracts; owner_id uuid; bal numeric; won boolean;
begin
 if p_price is null or p_price::text in ('NaN','Infinity','-Infinity') or p_price<=0 then raise exception 'Invalid quote'; end if;
 select user_id into owner_id from public.trade_contracts where id=p_id;
 if not found then return; end if;
 perform 1 from public.profiles where id=owner_id for update;
 select * into c from public.trade_contracts where id=p_id for update;
 if c.status<>'Active' then return; end if;
 if p_phase='entry' then
   if p_quote_at<>c.starts_at or clock_timestamp()<c.starts_at then raise exception 'Wrong entry timestamp'; end if;
   if c.entry_price is null then
     update public.trade_contracts set entry_price=p_price where id=c.id returning * into c;
     perform public.bb_publish_contract(c);
   end if;
 elsif p_phase='exit' then
   if p_quote_at<>c.expires_at or clock_timestamp()<c.expires_at then raise exception 'Trade is not due'; end if;
   if c.entry_price is null then raise exception 'Entry quote is pending'; end if;
   if p_price=c.entry_price then c.status:='Draw';c.payout:=c.amount;
   else
     won:=(c.direction='UP' and p_price>c.entry_price) or (c.direction='DOWN' and p_price<c.entry_price);
     c.status:=case when won then 'Won' else 'Lost' end;
     c.payout:=c.amount+case when won then c.profit else -c.profit end;
   end if;
   c.net:=c.payout-c.amount;c.exit_price:=p_price;c.settled_at:=clock_timestamp();
   update public.trade_contracts set status=c.status,payout=c.payout,net=c.net,exit_price=c.exit_price,settled_at=c.settled_at where id=c.id;
   update public.profiles set cash=cash+c.payout,
     assets=jsonb_set(assets,'{USDT}',jsonb_build_object('balance',cash+c.payout,'qty',cash+c.payout),true)
   where id=c.user_id returning cash into bal;
   insert into public.trade_ledger(contract_id,user_id,entry_type,delta,balance_after) values(c.id,c.user_id,'settlement',c.payout,bal);
   perform public.bb_publish_contract(c);
 else raise exception 'Invalid quote phase';
 end if;
end $$;
revoke all on function public.bb_apply_contract_quote(uuid,text,numeric,timestamptz) from public,anon,authenticated;
revoke all on function public.bb_publish_contract(public.trade_contracts) from public,anon,authenticated;
revoke all on function public.bb_contract_json(public.trade_contracts) from public,anon;

-- A missing entry quote is not an executed trade: refund the full reservation after 60 seconds.
create or replace function public.bb_refund_unpriced_contract(p_id uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.trade_contracts; owner_id uuid; bal numeric;
begin
 select user_id into owner_id from public.trade_contracts where id=p_id;
 if not found then return; end if;
 perform 1 from public.profiles where id=owner_id for update;
 select * into c from public.trade_contracts where id=p_id for update;
 if c.status<>'Active' or c.entry_price is not null or c.starts_at>clock_timestamp()-interval '60 seconds' then return; end if;
 update public.trade_contracts set status='Cancelled',payout=amount,net=0,settled_at=clock_timestamp() where id=c.id returning * into c;
 update public.profiles set cash=cash+c.amount,
   assets=jsonb_set(assets,'{USDT}',jsonb_build_object('balance',cash+c.amount,'qty',cash+c.amount),true)
 where id=c.user_id returning cash into bal;
 insert into public.trade_ledger(contract_id,user_id,entry_type,delta,balance_after) values(c.id,c.user_id,'close',c.amount,bal);
 delete from public.trade_quote_jobs where contract_id=c.id;
 perform public.bb_publish_contract(c);
end $$;
revoke all on function public.bb_refund_unpriced_contract(uuid) from public,anon,authenticated;

-- Runs with no users connected. Retries historical quotes for the exact original expiry.
create or replace function public.bb_contract_worker()
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare j record; resp record; candle jsonb; px numeric; ms bigint; rid bigint; host text;
begin
 if not pg_try_advisory_xact_lock(17493012,1) then return; end if;
 update public.trade_worker_health set last_run=clock_timestamp(),last_error=null where id;
 for j in select q.*,c.symbol from public.trade_quote_jobs q join public.trade_contracts c on c.id=q.contract_id
   where c.status='Active' and q.request_id is not null order by q.requested_at limit 100
 loop
   begin
     select * into resp from net._http_response where id=j.request_id;
     if not found then
       if j.requested_at<clock_timestamp()-interval '30 seconds' then raise exception 'Quote request expired; retrying'; end if;
       continue;
     end if;
     if resp.status_code is distinct from 200 or resp.timed_out or resp.error_msg is not null then
       raise exception 'Market data HTTP %, %',resp.status_code,coalesce(resp.error_msg,'unavailable');
     end if;
     candle:=(resp.content::jsonb)->0;
     ms:=floor(extract(epoch from j.quote_at)*1000)::bigint-1000;
     if jsonb_typeof(candle) is distinct from 'array' or (candle->>0)::bigint is distinct from ms
       or (candle->>6)::bigint is distinct from ms+999 then raise exception 'Missing exact one-second candle'; end if;
     px:=(candle->>4)::numeric;
     perform public.bb_apply_contract_quote(j.contract_id,j.phase,px,j.quote_at);
     delete from public.trade_quote_jobs where contract_id=j.contract_id and phase=j.phase;
   exception when others then
     update public.trade_quote_jobs set request_id=null,requested_at=null,error=left(sqlerrm,240),
       retry_at=clock_timestamp()+make_interval(secs=>least(60,greatest(5,attempts*5)))
     where contract_id=j.contract_id and phase=j.phase;
     update public.trade_worker_health set last_error=left(sqlerrm,240) where id;
   end;
 end loop;
 for j in select q.*,c.symbol from public.trade_quote_jobs q join public.trade_contracts c on c.id=q.contract_id
   where c.status='Active' and q.request_id is null and q.retry_at<=clock_timestamp()
     and q.quote_at+interval '1 second'<=clock_timestamp() and (q.phase='entry' or c.entry_price is not null)
   order by q.quote_at limit 40
 loop
   begin
     ms:=floor(extract(epoch from j.quote_at)*1000)::bigint-1000;
     -- Both hosts serve Binance spot data; never switch quote currencies or use demo data.
     host:=case when j.attempts%2=0 then 'https://data-api.binance.vision' else 'https://api.binance.com' end;
     rid:=net.http_get(url:=host||'/api/v3/klines',params:=jsonb_build_object('symbol',j.symbol||'USDT',
       'interval','1s','startTime',ms,'endTime',ms+999,'limit',1),timeout_milliseconds:=8000);
     update public.trade_quote_jobs set request_id=rid,requested_at=clock_timestamp(),attempts=attempts+1 where contract_id=j.contract_id and phase=j.phase;
   exception when others then
     update public.trade_quote_jobs set error=left(sqlerrm,240),retry_at=clock_timestamp()+interval '30 seconds' where contract_id=j.contract_id and phase=j.phase;
     update public.trade_worker_health set last_error=left(sqlerrm,240) where id;
   end;
 end loop;
 for j in select id from public.trade_contracts where status='Active' and entry_price is null and starts_at<clock_timestamp()-interval '60 seconds' limit 100 loop
   perform public.bb_refund_unpriced_contract(j.id);
 end loop;
end $$;
revoke all on function public.bb_contract_worker() from public,anon,authenticated;

-- Protect the compatibility rows too. Old deployed clients cannot settle/delete them.
create or replace function public.bb_guard_contract_rows()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 if current_user not in ('postgres','supabase_admin') then
   if (tg_op<>'INSERT' and old.kind in ('position','trade')) or (tg_op<>'DELETE' and new.kind in ('position','trade')) then
     raise exception 'Trades are managed by the settlement service. Reload the updated website';
   end if;
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
drop trigger if exists bb_contract_rows_guard on public.request_rows;
create trigger bb_contract_rows_guard before insert or update or delete on public.request_rows
 for each row execute function public.bb_guard_contract_rows();

-- Legacy contracts have no atomic debit ledger; do not guess whether they were already paid.
-- Retain their records and held balances for explicit reconciliation, never debit them again.
do $$
declare r record; d jsonb; c public.trade_contracts; h uuid;
begin
 for r in select * from public.request_rows where kind='position' and status='Active' and not (data ? 'serverManaged') loop
   begin
     d:=r.data;
     if exists(select 1 from public.trade_contracts where id=r.id) then continue; end if;
     select id into h from public.request_rows where kind='trade' and user_id=r.user_id and data->>'id'=d->>'id' order by created desc limit 1;
     insert into public.trade_contracts(id,user_id,ref,symbol,direction,amount,profit,duration,starts_at,expires_at,entry_price,status,legacy,position_row_id,history_row_id,created)
     values(r.id,r.user_id,coalesce(d->>'id',r.id::text),coalesce(d->>'sym',split_part(d->>'pair','/',1)),d->>'dir',
       (d->>'amt')::numeric,(d->>'profit')::numeric,(d->>'dur')::integer,to_timestamp((d->>'startTime')::numeric/1000),
       to_timestamp((d->>'startTime')::numeric/1000)+make_interval(secs=>(d->>'dur')::integer),(d->>'entryPrice')::numeric,
       'Review',true,r.id,coalesce(h,gen_random_uuid()),r.created) returning * into c;
     -- Preserve an already-terminal history row; it is evidence for reconciliation.
     if h is not null and exists(select 1 from public.request_rows where id=h and status<>'Active') then
       update public.trade_contracts set history_row_id=gen_random_uuid() where id=c.id returning * into c;
     end if;
     perform public.bb_publish_contract(c);
   exception when others then
     update public.request_rows set status='Review',data=data||jsonb_build_object('status','Review','reviewReason','Legacy record requires reconciliation') where id=r.id;
     raise notice 'Legacy position % requires review: %',r.id,sqlerrm;
   end;
 end loop;
end $$;

-- SQL-editor-only: use only after checking the original stake debit, entry source, and no previous payout.
create or replace function public.bb_resume_verified_legacy(p_id uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.trade_contracts;
begin
 select * into c from public.trade_contracts where id=p_id and legacy and status='Review' for update;
 if not found then raise exception 'Legacy review contract not found'; end if;
 if c.symbol<>all(array['BTC','ETH','BNB','SOL','XRP','ADA','DOGE','AVAX','LINK','TRX','DOT','LTC']) or coalesce(c.entry_price,0)<=0 then
   raise exception 'A verified crypto entry price is required';
 end if;
 -- Historical legacy timestamps use the preceding completed second, explicitly rounded down.
 update public.trade_contracts set status='Active',expires_at=date_trunc('second',expires_at) where id=c.id returning * into c;
 insert into public.trade_quote_jobs(contract_id,phase,quote_at) values(c.id,'exit',c.expires_at) on conflict do nothing;
 perform public.bb_publish_contract(c);
end $$;
revoke all on function public.bb_resume_verified_legacy(uuid) from public,anon,authenticated;

-- Composite index matches scoped page reads.
create index if not exists request_rows_user_kind_id on public.request_rows(user_id,kind,id);
-- Move old inline request attachments out of every page's request list.
do $$
declare r record; f text; item jsonb; bag jsonb; lean jsonb; ref text;
begin
 for r in select * from public.request_rows where kind in ('deposit','borrow','kyc') and data::text like '%data:%' loop
   bag:='{}'::jsonb;lean:=r.data;ref:='bb_doc_'||r.id::text;
   foreach f in array case when r.kind='kyc' then array['docs'] else array['proof'] end loop
     item:=r.data->f;
     if item is not null and item::text like '%data:%' then
       bag:=bag||jsonb_build_object(f,item);
       lean:=jsonb_set(lean,array[f],jsonb_build_object('name',coalesce(item->>'name','attachment'),'type',coalesce(item->>'type',''),
         'size',item->'size','ref',ref),true);
     end if;
   end loop;
   if bag<>'{}'::jsonb then
     insert into public.user_settings(user_id,key,value) values(r.user_id,ref,bag)
     on conflict(user_id,key) do update set value=public.user_settings.value||excluded.value;
     update public.request_rows set data=lean where id=r.id;
   end if;
 end loop;
end $$;
-- Re-runnable: replace only this project's job.
do $$ declare j record; begin
 for j in select jobid from cron.job where jobname='bitbase-contract-worker' loop perform cron.unschedule(j.jobid); end loop;
end $$;
select cron.schedule('bitbase-contract-worker','5 seconds','select public.bb_contract_worker();');
notify pgrst,'reload schema';
commit;

-- Check these after ~20 seconds. last_run should keep advancing with all browser tabs closed.
select jobname,schedule,active from cron.job where jobname='bitbase-contract-worker';
select * from public.trade_worker_health;
select status,count(*) from public.trade_contracts group by status;

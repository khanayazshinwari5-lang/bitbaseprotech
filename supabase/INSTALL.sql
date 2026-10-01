-- Bitbase auth, profile and realtime repair. Run the entire file in Supabase SQL Editor.
-- Idempotent; preserves existing users, balances, requests, messages and admin roles.
begin;

-- ==========================================================================
-- Bitbase – database schema
-- Supabase Studio -> SQL Editor -> paste the whole file -> Run. Safe to re-run.
--
-- Design note: the app is client-heavy and each screen reads and writes whole
-- collections at once. Rather than 30 hand-shaped tables that drift from the
-- UI, every request/trade/queue row is stored as a typed envelope -
--   id, user_id, status, amount, data jsonb, created, updated
-- where `data` is that row exactly as the app holds it in memory. Nothing is
-- lost, and the columns that get filtered on are indexed properly.
-- ==========================================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------------ profile
create table if not exists public.profiles (
  id             uuid primary key references auth.users(id) on delete cascade,
  code           text unique,                    -- the 6 digit id shown in the UI
  email          text not null default '',
  name           text not null default '',
  country        text not null default 'other',
  cash           numeric(20,4) not null default 0,
  funding        numeric(20,4) not null default 0,
  assets         jsonb not null default '{}'::jsonb,
  kyc_status     text not null default 'none',
  phone          text,
  phone_verified boolean not null default false,
  profit_mode    boolean not null default false,
  disabled       boolean not null default false,
  admin          boolean not null default false,
  is_owner       boolean not null default false,
  perms          jsonb not null default '{}'::jsonb,
  created        timestamptz not null default now(),
  login_at       timestamptz,
  updated        timestamptz not null default now()   -- written by touch_updated_at()
);
alter table public.profiles add column if not exists updated timestamptz not null default now();

create index if not exists profiles_created_idx on public.profiles (created desc);
create index if not exists profiles_admin_idx   on public.profiles (admin) where admin;

-- ------------------------------------------------------------ request rows
-- One shape for every ledger the console and the app move around.
create table if not exists public.request_rows (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null,                      -- 'deposit', 'trade', 'kyc', ...
  user_id    uuid not null references public.profiles(id) on delete cascade,
  ref        text,                               -- the app's own id, e.g. trade id
  status     text not null default 'pending',
  amount     numeric(20,4),
  created    timestamptz not null default now(),
  updated    timestamptz not null default now(),
  data       jsonb not null default '{}'::jsonb
);

-- A narrow view so queries can say "kind = 'deposit'" without touching jsonb.
create or replace view public.requests as
  select r.*, (r.data->>'uid')::text as legacy_uid
  from public.request_rows r;

create index if not exists request_rows_kind_idx    on public.request_rows (kind, created desc);
create index if not exists request_rows_user_idx    on public.request_rows (user_id, created desc);
create index if not exists request_rows_status_idx  on public.request_rows (kind, status);
create index if not exists request_rows_ref_idx     on public.request_rows (ref);

-- --------------------------------------------------------------- messaging
create table if not exists public.support_threads (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references public.profiles(id) on delete cascade,
  name       text not null default '',
  email      text not null default '',
  subject    text not null default 'Chat enquiry',
  status     text not null default 'open',
  created    timestamptz not null default now(),
  updated    timestamptz not null default now()
);
create index if not exists support_threads_user_idx on public.support_threads (user_id, updated desc);
create index if not exists support_threads_stat_idx on public.support_threads (status, updated desc);

create table if not exists public.support_messages (
  id         uuid primary key default gen_random_uuid(),
  thread_id  uuid not null references public.support_threads(id) on delete cascade,
  sender     text not null default 'user',        -- 'user' | 'admin'
  body       text not null default '',
  image      text,                                -- data: URL, already downscaled
  meta       jsonb not null default '{}'::jsonb,
  created    timestamptz not null default now()
);
create index if not exists support_messages_thread_idx on public.support_messages (thread_id, created);

-- ------------------------------------------------------------- app settings
-- Console-wide singletons: the admin access password hash, deposit addresses.
-- Only admins may write; every signed-in user may read the deposit addresses.
create table if not exists public.app_settings (
  key         text primary key,
  value       jsonb not null default '{}'::jsonb,
  updated     timestamptz not null default now()
);

-- Per-user key/value: preferences, demo balance, id counters, toggles.
create table if not exists public.user_settings (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  key         text not null,
  value       jsonb not null default '{}'::jsonb,
  updated     timestamptz not null default now(),
  primary key (user_id, key)
);

-- ------------------------------------------------------------------- audit
create table if not exists public.admin_log (
  id         uuid primary key default gen_random_uuid(),
  actor      uuid references public.profiles(id) on delete set null,
  actor_name text not null default '',
  action     text not null,
  target     text,
  detail     jsonb not null default '{}'::jsonb,
  created    timestamptz not null default now()
);
create index if not exists admin_log_created_idx on public.admin_log (created desc);

-- ===================================================================== RLS
-- Two rules everywhere: you see your own rows, and an admin sees everything.
-- `is_admin` / `is_owner` are SECURITY DEFINER so the policy on profiles can
-- read profiles without recursing.

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select admin from public.profiles where id = auth.uid() and not disabled), false);
$$;

create or replace function public.is_owner()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_owner from public.profiles where id = auth.uid() and not disabled), false);
$$;

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated = now(); return new; end $$;

alter table public.profiles        enable row level security;
alter table public.request_rows    enable row level security;
alter table public.support_threads enable row level security;
alter table public.support_messages enable row level security;
alter table public.app_settings    enable row level security;
alter table public.user_settings   enable row level security;
alter table public.admin_log       enable row level security;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();
drop trigger if exists request_rows_touch on public.request_rows;
create trigger request_rows_touch before update on public.request_rows
  for each row execute function public.touch_updated_at();
drop trigger if exists support_threads_touch on public.support_threads;
create trigger support_threads_touch before update on public.support_threads
  for each row execute function public.touch_updated_at();
drop trigger if exists app_settings_touch on public.app_settings;
create trigger app_settings_touch before update on public.app_settings
  for each row execute function public.touch_updated_at();

-- profiles: read yourself, or anything at all if you are an admin.
-- Writing yourself is limited to the cosmetic columns - admin/owner/disabled
-- can only be changed by another admin, which is the whole point of the roles.
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select
  using (id = auth.uid() or public.is_admin());

drop policy if exists profiles_insert_self on public.profiles;
-- Profile insertion is handled by handle_new_user / ensure_my_profile only.

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());
drop policy if exists profiles_delete_admin on public.profiles;
create policy profiles_delete_admin on public.profiles for delete
  using (public.is_admin());

-- The column guard: a plain user can edit their profile but must not promote
-- themselves, hand themselves permissions, or unban themselves.
create or replace function public.profiles_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;      -- service role / SQL editor
  if public.is_admin() then return new; end if;
  if new.admin is distinct from old.admin
     or new.is_owner is distinct from old.is_owner
     or new.perms is distinct from old.perms
     or new.disabled is distinct from old.disabled
     or new.code is distinct from old.code then
    raise exception 'role fields can only be changed by an admin';
  end if;
  return new;
end $$;

drop trigger if exists profiles_guard_trg on public.profiles;
create trigger profiles_guard_trg before update on public.profiles
  for each row execute function public.profiles_guard();

-- request_rows
drop policy if exists request_rows_read on public.request_rows;
create policy request_rows_read on public.request_rows for select
  using (user_id = auth.uid() or public.is_admin());
drop policy if exists request_rows_write on public.request_rows;
create policy request_rows_write on public.request_rows for insert
  with check (user_id = auth.uid() or public.is_admin());
drop policy if exists request_rows_update on public.request_rows;
create policy request_rows_update on public.request_rows for update
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());
drop policy if exists request_rows_delete on public.request_rows;
create policy request_rows_delete on public.request_rows for delete
  using (user_id = auth.uid() or public.is_admin());

-- support_threads
drop policy if exists threads_read on public.support_threads;
create policy threads_read on public.support_threads for select
  using (user_id = auth.uid() or public.is_admin());
drop policy if exists threads_write on public.support_threads;
create policy threads_write on public.support_threads for insert
  with check (user_id = auth.uid() or public.is_admin());
drop policy if exists threads_update on public.support_threads;
create policy threads_update on public.support_threads for update
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());
drop policy if exists threads_delete on public.support_threads;
create policy threads_delete on public.support_threads for delete
  using (user_id = auth.uid() or public.is_admin());

-- support_messages: reach the parent thread to decide.
drop policy if exists messages_read on public.support_messages;
create policy messages_read on public.support_messages for select
  using (exists (select 1 from public.support_threads t
                 where t.id = thread_id
                   and (t.user_id = auth.uid() or public.is_admin())));
drop policy if exists messages_write on public.support_messages;
create policy messages_write on public.support_messages for insert to authenticated
  with check (
    (sender = 'admin' and public.is_admin() and exists (
      select 1 from public.support_threads t where t.id = thread_id))
    or (sender = 'user' and exists (
      select 1 from public.support_threads t where t.id = thread_id and t.user_id = auth.uid()))
  );
drop policy if exists messages_delete on public.support_messages;
create policy messages_delete on public.support_messages for delete
  using (public.is_admin());

-- app_settings: reads are open to signed-in users, writes to admins only.
drop policy if exists settings_read on public.app_settings;
create policy settings_read on public.app_settings for select
  using ((key = 'deposit_addresses' and auth.uid() is not null) or public.is_admin());
drop policy if exists settings_write on public.app_settings;
create policy settings_write on public.app_settings for all
  using (public.is_admin()) with check (public.is_admin());

-- user_settings
drop policy if exists user_settings_read on public.user_settings;
create policy user_settings_read on public.user_settings for select
  using (user_id = auth.uid() or public.is_admin());
drop policy if exists user_settings_write on public.user_settings;
create policy user_settings_write on public.user_settings for all
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

-- admin_log
drop policy if exists admin_log_read on public.admin_log;
create policy admin_log_read on public.admin_log for select
  using (public.is_admin());
drop policy if exists admin_log_write on public.admin_log;
create policy admin_log_write on public.admin_log for insert
  with check (actor = auth.uid() or public.is_admin());

-- Profile creation is atomic with auth signup. Only trusted SQL explicitly grants
-- the initial admin role; existing admin/owner flags are never changed by repair.
create or replace function public.create_profile_for(v_user uuid)
returns public.profiles language plpgsql security definer set search_path = public, pg_temp as $$
declare
  u auth.users%rowtype;
  p public.profiles%rowtype;
  v_code text;
begin
  select * into p from public.profiles where id = v_user;
  if found then return p; end if;
  select * into u from auth.users where id = v_user;
  if not found then raise exception 'Auth account not found'; end if;
  for attempt in 1..100 loop
    v_code := (floor(random() * 900000) + 100000)::bigint::text;
    begin
      insert into public.profiles (id,code,email,name,country)
      values (u.id,v_code,coalesce(u.email,''),coalesce(u.raw_user_meta_data->>'name','User'),
        coalesce(u.raw_user_meta_data->>'country','other'))
      on conflict (id) do nothing;
      select * into p from public.profiles where id = u.id;
      return p;
    exception when unique_violation then
      -- Retry only a rare code collision; never assign elevated roles.
      null;
    end;
  end loop;
  raise exception 'Could not allocate a profile code';
end $$;
revoke all on function public.create_profile_for(uuid) from public, anon, authenticated;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.create_profile_for(new.id);
  return new;
end $$;
revoke all on function public.handle_new_user() from public, anon, authenticated;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.ensure_my_profile()
returns public.profiles language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  return public.create_profile_for(auth.uid());
end $$;
revoke all on function public.ensure_my_profile() from public, anon;
grant execute on function public.ensure_my_profile() to authenticated;

-- Recover every orphaned signup as an ordinary account. Existing roles stay intact.
do $$
declare v_id uuid;
begin
  for v_id in select u.id from auth.users u left join public.profiles p on p.id = u.id
    where p.id is null order by u.created_at, u.id
  loop
    perform public.create_profile_for(v_id);
  end loop;
end $$;

-- An admin reply must never move the conversation to the admin's account.
create or replace function public.guard_support_owner()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.user_id is distinct from old.user_id then
    raise exception 'Conversation ownership cannot be changed';
  end if;
  return new;
end $$;
drop trigger if exists support_owner_guard on public.support_threads;
create trigger support_owner_guard before update on public.support_threads
  for each row execute function public.guard_support_owner();

-- Message arrival updates the thread order in both clients.
create or replace function public.touch_support_thread()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.support_threads set updated = clock_timestamp() where id = new.thread_id;
  return new;
end $$;
revoke all on function public.touch_support_thread() from public, anon, authenticated;
drop trigger if exists support_message_touch on public.support_messages;
create trigger support_message_touch after insert on public.support_messages
  for each row execute function public.touch_support_thread();

-- Table grants work together with RLS. Anonymous requests have no table access.
grant usage on schema public to authenticated;
grant select, update, delete on public.profiles to authenticated;
revoke insert on public.profiles from authenticated;
grant select, insert, update, delete on public.request_rows to authenticated;
grant select, insert, update, delete on public.support_threads to authenticated;
grant select, insert, delete on public.support_messages to authenticated;
grant select, insert, update, delete on public.app_settings to authenticated;
grant select, insert, update, delete on public.user_settings to authenticated;
grant select, insert on public.admin_log to authenticated;
revoke all on public.profiles,public.request_rows,public.support_threads,public.support_messages,
  public.app_settings,public.user_settings,public.admin_log from anon;
alter view public.requests set (security_invoker = true);

-- Required for postgres_changes subscriptions. Re-running adds no duplicates.
do $$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime' and puballtables) then
    foreach t in array array['profiles','request_rows','support_threads','support_messages','app_settings','user_settings'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
        and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I',t);
      end if;
    end loop;
  end if;
end $$;
notify pgrst, 'reload schema';
commit;

-- Expected: missing_profiles = 0. Existing admin/owner counts are unchanged.
select count(*) as missing_profiles from auth.users u left join public.profiles p on p.id=u.id where p.id is null;
select count(*) filter (where admin) as admins, count(*) filter (where is_owner) as owners from public.profiles;
select tablename from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' order by tablename;
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
  -- True when the console's Profit Mode switch, not the price, decided the
  -- outcome. The recorded entry and exit prices stay the real ones either way.
  forced boolean not null default false,
  position_row_id uuid not null default gen_random_uuid(),
  history_row_id uuid not null default gen_random_uuid(),
  created timestamptz not null default now(),
  check(expires_at > starts_at)
);
-- create table if not exists leaves an existing table alone, so a database that
-- already ran an earlier version gains the new column here.
alter table public.trade_contracts add column if not exists forced boolean not null default false;
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
    'mode','real','serverManaged',true,'legacy',c.legacy,'forced',c.forced,
    'payout',c.payout,'net',c.net,
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

-- Removing an account has to start at the login, not at the profile. Deleting the
-- profiles row alone leaves the sign-in intact, and the next time that person
-- signs in create_profile_for builds them a brand-new account - so the console
-- reported a deletion that had not happened. auth.users is the parent of
-- profiles, so one delete there cascades to the profile and from there to every
-- contract, ledger, chat, request and setting the account owns.
create or replace function public.bb_delete_account(p_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare me uuid:=auth.uid(); t public.profiles; admins integer; done jsonb;
begin
  if me is null then raise exception 'Sign in first'; end if;
  if not public.is_admin() then raise exception 'Administrator access is required'; end if;
  if p_id is null then raise exception 'No account was selected'; end if;
  if p_id=me then raise exception 'You cannot delete the account you are signed in with'; end if;
  select * into t from public.profiles where id=p_id;
  if not found then raise exception 'No such account'; end if;
  if t.is_owner then raise exception 'The console owner cannot be deleted'; end if;
  -- Refuse to leave the console with nobody who can administer it.
  if t.admin then
    select count(*) into admins from public.profiles where admin and not disabled and id<>p_id;
    if admins<1 then raise exception 'Cannot delete the last remaining admin'; end if;
  end if;
  done:=jsonb_build_object('id',p_id,'name',t.name,'email',t.email,'cash',t.cash);
  delete from auth.users where id=p_id;
  if not found then delete from public.profiles where id=p_id; end if;
  return done||jsonb_build_object('ok',true,'signinRemoved',true);
end $$;
revoke all on function public.bb_delete_account(uuid) from public,anon;
grant execute on function public.bb_delete_account(uuid) to authenticated;

-- Private worker operation. No browser/admin API can supply a settlement price.
create or replace function public.bb_apply_contract_quote(p_id uuid,p_phase text,p_price numeric,p_quote_at timestamptz)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.trade_contracts; owner_id uuid; bal numeric; won boolean; forced_win boolean;
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
    -- p_price is the genuine one-second candle at expiry and is always stored.
    -- Profit Mode is the only thing that can override the verdict, and it is read
    -- here from the owner's own profile row: the caller still cannot supply a
    -- price, a direction or this flag. A forced contract wins outright, so it can
    -- never settle as a draw, and the flag is written for the audit trail.
    select profit_mode into forced_win from public.profiles where id=owner_id;
    if coalesce(forced_win,false) then c.status:='Won';c.payout:=c.amount+c.profit;
    elsif p_price=c.entry_price then c.status:='Draw';c.payout:=c.amount;
    else
      won:=(c.direction='UP' and p_price>c.entry_price) or (c.direction='DOWN' and p_price<c.entry_price);
      c.status:=case when won then 'Won' else 'Lost' end;
      c.payout:=c.amount+case when won then c.profit else -c.profit end;
    end if;
    c.net:=c.payout-c.amount;c.exit_price:=p_price;c.settled_at:=clock_timestamp();
    update public.trade_contracts set status=c.status,payout=c.payout,net=c.net,exit_price=c.exit_price,settled_at=c.settled_at,
      forced=coalesce(forced_win,false) and c.status='Won' where id=c.id;
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

-- Protect the compatibility rows too. Old deployed clients cannot settle them.
create or replace function public.bb_guard_contract_rows()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if current_user not in ('postgres','supabase_admin') then
    -- A delete inside a referential cascade is a consequence of a delete RLS
    -- already allowed on the parent row: the admin removing an account, whose
    -- contracts and history have to go with it. Refusing it there stranded rows
    -- that nothing else is allowed to remove.
    if tg_op='DELETE' and pg_trigger_depth()>1 then return old; end if;
    -- The console's Delete on a settled history row is a display decision, not an
    -- outcome: the contract, its ledger entry and the balance credit are already
    -- final and the worker will never touch it again. Open and Review positions,
    -- and every write, stay owned by the settlement service.
    if tg_op='DELETE' and old.kind='trade' and old.status not in ('Active','Review') and public.is_admin() then
      return old;
    end if;
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

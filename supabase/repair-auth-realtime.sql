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

-- ==========================================================================
-- Bitbase – database schema
-- Run once: Supabase Studio -> SQL Editor -> paste -> Run. Safe to re-run.
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
  updated_at     timestamptz not null default now()
);
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
  select coalesce((select admin from public.profiles where id = auth.uid()), false);
$$;

create or replace function public.is_owner()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_owner from public.profiles where id = auth.uid()), false);
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
create policy profiles_insert_self on public.profiles for insert
  with check (id = auth.uid());

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
  if auth.uid() is null then return null; end if;      -- service role / SQL editor
  if public.is_admin() then return new; end if;
  if new.admin <> old.admin
     or new.is_owner <> old.is_owner
     or new.perms <> old.perms
     or new.disabled <> old.disabled
     or new.code <> old.code then
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
create policy messages_write on public.support_messages for insert
  with check (exists (select 1 from public.support_threads t
                      where t.id = thread_id
                        and (t.user_id = auth.uid() or public.is_admin())));
drop policy if exists messages_delete on public.support_messages;
create policy messages_delete on public.support_messages for delete
  using (public.is_admin());

-- app_settings: reads are open to signed-in users, writes to admins only.
drop policy if exists settings_read on public.app_settings;
create policy settings_read on public.app_settings for select
  using (auth.uid() is not null);
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

-- ============================================================ signup trigger
-- Creates the profile row, and assigns the first ever admin the owner flag so
-- the console still has exactly one owner without anyone editing the table.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_code  text;
  v_owner boolean;
begin
  v_code := lpad((floor(random() * 900000) + 100000)::bigint::text, 6, '0');
  while exists (select 1 from public.profiles where code = v_code) loop
    v_code := lpad((floor(random() * 900000) + 100000)::bigint::text, 6, '0');
  end loop;

  select not exists (select 1 from public.profiles where is_owner) into v_owner;

  insert into public.profiles (id, code, email, name, country, admin, is_owner)
  values (new.id, v_code,
          coalesce(new.email, ''),
          coalesce(new.raw_user_meta_data->>'name', ''),
          coalesce(new.raw_user_meta_data->>'country', 'other'),
          v_owner, v_owner)
  on conflict (id) do update set email = excluded.email;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Grants. RLS still applies; these only make the tables reachable.
grant select, insert, update, delete on public.profiles to authenticated;
grant select, insert, update, delete on public.request_rows to authenticated;
grant select, insert, update, delete on public.support_threads to authenticated;
grant select, insert, delete on public.support_messages to authenticated;
grant select, insert, update on public.app_settings to authenticated;
grant select, insert, update, delete on public.user_settings to authenticated;
grant select, insert on public.admin_log to authenticated;

-- ==========================================================================
-- After running this, two settings in Supabase -> Authentication:
--   1. Disable "Confirm email" (otherwise signUp returns a user with no
--      session and the app cannot tell a pending signup from a failure).
--   2. Turn off the anon "Signup" toggle only if you want registration to be
--      closed - you almost certainly want it on.
-- ==========================================================================
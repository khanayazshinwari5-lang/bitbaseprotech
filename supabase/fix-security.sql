-- ==========================================================================
-- Bitbase – security repair
--
-- Symptom this fixes:
--   signup succeeds, then "Your account was created but could not be loaded",
--   and every console screen is empty.
--
-- Why: `alter table ... enable row level security` runs early in schema.sql
-- but the policies come further down. If anything in between failed, the
-- tables are locked down with RLS switched on and NO policies - which denies
-- every read and write to everybody, including the signed-in user. Signup works
-- (that is auth.users, a different system), but nothing can read profiles.
--
-- Safe to run as many times as you like: every statement drops before it
-- creates.
--
-- NOTE: the SQL editor runs a whole paste as ONE transaction, so a single bad
-- statement rolls the entire script back. Everything that CHANGES the database
-- is therefore first, and every read-only check is at the very bottom - there
-- is nothing left to lose if a query at the end is wrong.
-- ==========================================================================

-- ------------------------------------------------------- helper functions
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

-- A plain user may edit their profile but must not promote themselves, hand
-- themselves permissions, or unban themselves.
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

-- ---------------------------------------------------------------- policies
alter table public.profiles        enable row level security;
alter table public.request_rows    enable row level security;
alter table public.support_threads enable row level security;
alter table public.support_messages enable row level security;
alter table public.app_settings    enable row level security;
alter table public.user_settings   enable row level security;
alter table public.admin_log       enable row level security;

-- profiles
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

-- app_settings: reads open to anyone signed in, writes to admins only.
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

-- ---------------------------------------------------------------- triggers
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
drop trigger if exists profiles_guard_trg on public.profiles;
create trigger profiles_guard_trg before update on public.profiles
  for each row execute function public.profiles_guard();

-- ------------------------------------------------------------------ grants
grant select, insert, update, delete on public.profiles to authenticated;
grant select, insert, update, delete on public.request_rows to authenticated;
grant select, insert, update, delete on public.support_threads to authenticated;
grant select, insert, delete on public.support_messages to authenticated;
grant select, insert, update on public.app_settings to authenticated;
grant select, insert, update, delete on public.user_settings to authenticated;
grant select, insert on public.admin_log to authenticated;

-- ------------------------------------------------------------ signup trigger
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

  -- Whoever registers when nobody owns the console becomes the first admin.
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

-- --------------------------------------------------------------- backfill
-- One row per auth user that is missing one. The first account repaired also
-- becomes the console owner, so run this before registering anyone else.
insert into public.profiles (id, code, email, name, country, admin, is_owner)
select u.id,
       lpad((floor(random() * 900000) + 100000)::bigint::text, 6, '0'),
       coalesce(u.email, ''),
       coalesce(u.raw_user_meta_data->>'name', 'User'),
       coalesce(u.raw_user_meta_data->>'country', 'other'),
       true, true
  from auth.users u
 where not exists (select 1 from public.profiles p where p.id = u.id)
   and not exists (select 1 from public.profiles where is_owner);

insert into public.profiles (id, code, email, name, country)
select u.id,
       lpad((floor(random() * 900000) + 100000)::bigint::text, 6, '0'),
       coalesce(u.email, ''),
       coalesce(u.raw_user_meta_data->>'name', 'User'),
       coalesce(u.raw_user_meta_data->>'country', 'other')
  from auth.users u
 where not exists (select 1 from public.profiles p where p.id = u.id);

-- ------------------------------------------------------ verify afterwards
-- Everything above this line has already been committed by the time these run,
-- so a mistake in a check costs you nothing.
--
-- 1. Policies per table. Before the repair this returns nothing at all -
--    that was the cause. You want a row for each of the seven tables.
select tablename, policyname, cmd from pg_policies
 where schemaname = 'public' order by tablename, policyname;

-- 2. RLS actually enabled, i.e. every table is protected.
select c.relname as table_name, c.relrowsecurity as rls_enabled
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r'
 order by c.relname;

-- 3. One profile per account, and exactly one console owner.
select p.code, p.email, p.name, p.admin, p.is_owner,
       (u.confirmed_at is not null) as email_confirmed
  from public.profiles p
  join auth.users u on u.id = p.id
 order by p.created;

select count(*) as owners from public.profiles where is_owner;
select count(*) as policies_total from pg_policies where schemaname = 'public';
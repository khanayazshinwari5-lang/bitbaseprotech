-- ==========================================================================
-- Bitbase – repair script
--
-- Use this if registration succeeds but the app then says
-- "Your account was created but could not be loaded", which means auth.users
-- got the new account but public.profiles never got its row - the signup
-- trigger is missing or was not created when schema.sql ran.
--
-- Safe to run more than once.
-- ==========================================================================

-- 1. Does the profile row exist for anyone at all?
--    No rows here means the trigger never fired: run step 2.
select count(*) as profiles_total from public.profiles;
select email, confirmed_at is not null as confirmed
  from auth.users order by created_at desc limit 10;

-- --------------------------------------------------------------------------
-- 2. Re-create the signup trigger. Creating the profile server-side is the
--    right place for it: it is atomic with the account, and only the database
--    can decide who the very first admin is.
-- --------------------------------------------------------------------------
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

-- --------------------------------------------------------------------------
-- 3. Backfill: give every auth user without a profile one. The first account
--    to be repaired becomes the console owner, so run this once, before you
--    register any other test accounts.
-- --------------------------------------------------------------------------
insert into public.profiles (id, code, email, name, country, admin, is_owner)
select u.id,
       lpad((floor(random() * 900000) + 100000)::bigint::text, 6, '0'),
       coalesce(u.email, ''),
       coalesce(u.raw_user_meta_data->>'name', 'User'),
       coalesce(u.raw_user_meta_data->>'country', 'other'),
       true,
       true
  from auth.users u
 where not exists (select 1 from public.profiles p where p.id = u.id)
   and not exists (select 1 from public.profiles where is_owner);

-- Any remaining orphans, as ordinary users rather than admins.
insert into public.profiles (id, code, email, name, country)
select u.id,
       lpad((floor(random() * 900000) + 100000)::bigint::text, 6, '0'),
       coalesce(u.email, ''),
       coalesce(u.raw_user_meta_data->>'name', 'User'),
       coalesce(u.raw_user_meta_data->>'country', 'other')
  from auth.users u
 where not exists (select 1 from public.profiles p where p.id = u.id);

-- --------------------------------------------------------------------------
-- 4. Confirm the result: you want one row per auth user, and exactly one owner.
-- --------------------------------------------------------------------------
select p.code, p.email, p.name, p.admin, p.is_owner,
       (u.confirmed_at is not null) as email_confirmed
  from public.profiles p
  join auth.users u on u.id = p.id
 order by p.created;
select count(*) as owners from public.profiles where is_owner;
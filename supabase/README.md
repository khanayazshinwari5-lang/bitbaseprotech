# Supabase setup

Start with `../README-FIRST.md`.

Run **repair-auth-realtime.sql** as a complete script in the project's Supabase
SQL Editor for either an existing or a fresh database. **schema.sql** contains
the identical setup. The old `fix-profile.sql` and `fix-security.sql` files are
retired to avoid reintroducing their incompatible and unsafe partial repairs.

The script:

- Creates any missing application tables and the profiles `updated` column.
- Restores the signup trigger and backfills orphaned auth accounts as ordinary
  users without modifying existing admin/owner flags.
- Provides `ensure_my_profile()`, which repairs only the caller's own profile
  using server-side defaults. Direct browser profile insertion is disabled.
- Restores authenticated RLS/grants and validates support-message sender roles.
- Preserves thread ownership when admins reply and updates thread activity when
  a message arrives.
- Fixes the profile guard's SQL-editor/service update return value.
- Adds six application tables to `supabase_realtime` idempotently and refreshes
  the PostgREST schema cache.

No service-role secret is shipped or used by the frontend. SQL application
requires the project owner's database access; the public browser key cannot
perform migrations.

The bridge pages through database results and listens to profile, request,
thread, message and settings changes. It uses an in-memory typed mirror so the
existing page APIs remain synchronous, then serializes changed writes with
acknowledgement, retry and visible failures. It does not upload local demo users.

Reference documentation:
- https://supabase.com/docs/reference/javascript/auth-getsession
- https://supabase.com/docs/reference/javascript/auth-onauthstatechange
- https://supabase.com/docs/guides/realtime/postgres-changes

The SQL was reviewed but could not be executed against the configured live
project in this environment. Follow the final result queries and LIVE-CHECK.md.

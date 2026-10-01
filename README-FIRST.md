# Install this fix

This replaces the broken login/signup, shared database mirror, request syncing,
and customer/admin chat delivery paths. Keep your existing Supabase project.

1. Open your project's **Supabase → SQL Editor**. Run the entire
   **`supabase/repair-auth-realtime.sql`** file once. It repairs missing profiles,
   access policies and the signup trigger, and enables the six realtime tables.
   Existing profiles, balances, requests, messages and admin roles are preserved.
2. Replace the website files with the contents of this `bitbasepro.org` folder
   and redeploy. The existing public Supabase URL/key remain in
   `assets/js/supabase-config.js`. No secret/service-role key belongs there.
3. Hard-refresh the site. Sign in to an existing admin account in one browser
   and register/sign in to a customer account in a different browser or private
   window. Follow `LIVE-CHECK.md` to confirm your deployed project.

**Both the SQL step and the website update are required.** Replacing HTML alone
cannot repair Supabase policies or enable its realtime publication.

## If no account has admin access

The repair preserves existing admin roles. It never promotes an arbitrary new
signup or an orphaned account. If your project has no admin, choose your own
registered account and run this in the trusted Supabase SQL Editor, replacing
`YOUR_ADMIN_EMAIL` with its exact email:

```sql
update public.profiles
set admin = true, is_owner = true
where lower(email) = lower('YOUR_ADMIN_EMAIL');
```

This must update exactly your intended account. Sign out and sign back in after
granting access. An ordinary customer cannot promote themselves using the
browser's old admin-password screen.

## Email confirmation

The app supports Supabase email confirmation being on or off. When enabled,
signup shows a successful "check your inbox" message and waits for confirmation;
it does not invent a signed-in session. Set your actual site domain and allowed
redirects in Supabase Authentication URL Configuration. Already-created accounts
should use **Sign in**, rather than registering the same email again.

## Delivery behavior

Once a write is accepted by Supabase, subscribed clients refresh automatically.
A visible page also polls every four seconds and refreshes on focus/reconnect,
so missed events can recover. Timing depends on the connection and Supabase;
"instant" delivery cannot be guaranteed when offline or in suspended tabs.

Requests and chat show save failures. Failed writes remain queued in the open
tab, with a **Retry** button. Keep the tab open until the retry succeeds. A
navigation warning protects pending writes, but closing the tab forcibly loses
unacknowledged in-memory changes. Message IDs make retries idempotent even when
the server committed a message but its response was lost.

The site does not silently switch to browser-only accounts if Supabase fails.
An intentional offline demo is still available with `useSupabase: false`.

## Verification provided

Run `npm test` (Node.js 20 or later; no npm dependencies are needed).
`TEST-REPORT.md` explains exactly what was tested and what still needs live
verification. These files were not deployed and the SQL was not applied to your
live project in this session.

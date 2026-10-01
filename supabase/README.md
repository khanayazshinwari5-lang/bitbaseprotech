# Bitbase — Supabase backend

The site used to keep everything in `localStorage`: accounts, balances, trades,
support threads, the admin console. It now has a real backend. This file is the
runbook.

---

## 1. Create the project

1. <https://supabase.com/dashboard> → **New project**.
2. Remember the database password (the one starting `postgres`).
3. Wait for the project to finish provisioning.

## 2. Run the schema

**SQL Editor** → **New query** → paste the whole of [`schema.sql`](schema.sql) →
**Run**.

It creates every table, the row level security policies, and a trigger that
builds a profile row for each new signup. All of it is `if not exists`, so
running it twice is harmless.

## 3. Fill in the connection

`assets/js/supabase-config.js`:

```js
supabaseUrl: 'https://xxxxxxxxxxxx.supabase.co',
supabaseAnonKey: 'eyJhbGciOi...'
```

Both are in **Project Settings → API**. The `anon`/`public` key is the one to
use — it is designed to be visible in the browser, and the RLS policies decide
what it may touch. **Never** put the `service_role` key in this file: it skips
row level security entirely.

## 4. Turn off email confirmation

**Authentication → Sign In / Providers → Email** → untick **Confirm email**.

With it on, `signUp` returns a user with no session. The app then tries to sign
in straight away and tells you to confirm the address if that fails — so it
degrades instead of breaking — but turning it off is what you want for a demo.

Leave the **Enable signup** toggle on unless you want registration closed.

## 5. Get some data in

The database starts empty, and **the console can only show what is in it**.

1. Open the site and **register an account**. The signup trigger makes the very
   first account both admin and owner, so that account opens the console with
   every permission.
2. Register one or two more accounts (in a private window, or sign out between
   them) to have users, balances and activity to look at.
3. Sign in as the first account and open `/admin.html`.

Accounts that only ever existed in `localStorage` cannot be brought across —
Supabase Auth owns passwords now, and the anon key cannot create or move auth
users. Register them again.

## 6. Deploy

Push the folder to Vercel as usual. Nothing else is needed — there is no build
step, it is static files plus the Supabase CDN client.

---

## If data is not showing

The page says *"Database not connected"* at the bottom when the project cannot
be reached; the reason is in the browser console next to `[bitbase-db]`.

| Symptom | Cause |
|---|---|
| Banner, console shows 404 | `supabaseUrl` has `/rest/v1` pasted into it. Use the bare project URL — `db.js` strips a trailing `/rest/v1`, but do it properly anyway. |
| Everything works, but the console is empty | The database genuinely has no rows. Register accounts. |
| `relation "profiles" does not exist` | `schema.sql` was never run, or run in the wrong project. |
| Signup says "check your inbox" | "Confirm email" is on. Turn it off, or confirm the address. |
| Everything works on your machine, not on Vercel | A config file was not deployed — hard-refresh, and check `supabase-config.js` on the live domain. |

---

## How it is wired

```
assets/js/supabase-config.js   your URL + anon key
assets/js/db.js                the data layer (mirror, hydration, write queue)
assets/js/auth.js              accounts, roles, the storage seam
supabase/schema.sql            tables + RLS + signup trigger
```

### The mirror

The app was written against a synchronous browser store: pages call
`A.get` / `A.set` / `A.writeJSON` and expect the value straight back. Rewriting
twelve pages to await every read would be a large change for no benefit, so
`db.js` keeps that API and makes it honest:

- **Reads** hit an in-memory mirror under the same `bb_*` keys, so they stay
  synchronous and every page is unchanged.
- **Boot** (`BB.ready`) loads the signed-in user's rows from Postgres into the
  mirror before any page renders, so the first paint is already correct.
- **Writes** update the mirror immediately and queue the change for the
  database, debounced 220ms. The UI never waits on the network.

If Supabase is unreachable or not configured, the same four functions fall
through to `localStorage` and the site keeps working standalone.

### Tables

| Table | Holds |
|---|---|
| `profiles` | one row per account: balances, assets, roles, KYC |
| `request_rows` | every ledger — deposits, withdrawals, loans, KYC, trades, positions, activity, notifications, audit adjustments. One envelope table with a `kind` discriminator, so a new feature is one line in `MAP`, not a migration |
| `support_threads` / `support_messages` | the customer chat, including attached pictures |
| `app_settings` | console singletons: the admin access password hash, deposit addresses |
| `user_settings` | per-user key/value: preferences, demo balance, id counters |
| `admin_log` | who changed what, from the console |

### Security

Row level security does the real work, and the browser is not trusted:

- you can read and write your own rows;
- an admin can read and write everything;
- a **trigger** on `profiles` refuses any change to `admin`, `is_owner`, `perms`,
  `disabled` or `code` unless the caller is already an admin — so a user cannot
  promote themselves by editing their own profile;
- deleting an account cascades: ledgers, threads and settings go with it.

### First admin

The signup trigger makes the **first account to register** the admin and owner
(`admin` and `is_owner` both true). Every later account starts as an ordinary
user. To change who owns the console, use the **First Admin** switch in the
console (Users → Edit), which asks for the admin password and writes the column
through the admin-only path.

---

## Things worth knowing

- **Legacy local data is not migrated.** Accounts that already exist only in
  `localStorage` under 6-digit ids cannot be moved across automatically —
  Supabase Auth owns passwords now. Register them again, or seed them with the
  service key from a script.
- **Deleting a user** drops the profile and everything cascading from it, but
  not the row in `auth.users`. Remove that by hand in **Authentication → Users**,
  or through an Edge Function holding the service key. The anon key cannot do it.
- **Support pictures** are stored as `data:` URLs in `support_messages.image`,
  already downscaled to 1000px JPEG. Postgres `text` handles them; keep an eye
  on row size if you later allow video.
- **No backend was added for the market feed** — prices still come from the
  public APIs in `assets/js/data.js`. That is deliberate: it is read-only public
  data with no need to persist.
- Everything here is verified by reading and syntax checks only. Run the schema
  and a real signup/login before trusting it with anything.
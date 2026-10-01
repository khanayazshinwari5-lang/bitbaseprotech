# Repair validation — 2 October 2026

## Passed locally

- **51 / 51 JavaScript tests** (`npm test`): authentication and profile restoration, registration, admin visibility, support request/chat delivery, attachment separation, save retries, page boot gates, pagination, scoped reads and trade frontend behavior.
- All application JavaScript files and nine inline scripts pass Node syntax checking.
- Every local script/stylesheet/favicon reference in the HTML resolves to an included file.
- Remote trade checks cover no browser-side credit, no real forced-win override, unchanged balance on rejection, same UUID after an uncertain response, different-payload retry rejection, server balance acknowledgement without profile writes, one result event, and rejection of a stale profile update after a settlement credit.
- Offline arithmetic checks cover symmetric win/loss payouts, stake reservation/return, invalid prices, future expiry, repeated/overlapping sweeps and reopening a practice/offline page. **These are not tests of PostgreSQL concurrency or live market settlement.**
- Demo positions and history persist in separate per-user settings.

Initial database reads in the scoped fixture, before market-data calls:

| Page | Previous startup | Repaired startup |
| --- | ---: | ---: |
| Dashboard | 7 | 2 |
| Assets, including support | 7 | 6 |
| Markets | 7 | 1 |
| Trade | 7 | 2 |
| History | 7 | 3 |
| Demo | 7 | 2 |
| Settings | 7 | 3 |

These are request counts, not measured production load-time improvements. Request sizes are also reduced by user/kind filters. The SQL migration removes old inline request attachments. Page styling no longer needs the Tailwind CDN/compiler; icons are local. The Supabase SDK still uses a CDN with a second-host fallback.

## Still requires deployment verification

- The new SQL migration, PostgreSQL locking/RLS/grants and scheduled HTTP requests were **not executed against live Supabase**. No database management credentials were available, and this workspace has no PostgreSQL engine. `supabase/test-settlement.sql` supplies rollback-based staging assertions; `supabase/check-settlement.sql` supplies operational diagnostics.
- Real expiry prices, closed-browser credits and provider availability require **LIVE-CHECK.md**. The new worker runs in Supabase only after INSTALL.sql is applied. A file-only deployment does not enable it.
- Browser visual/navigation smoke testing could not run: local Playwright has no browser binary, and the cloud browser blocked the local preview URL. An optional `tests/browser-smoke.cjs` harness is included for a local server with Playwright/Chromium installed. It uses fixtures, not real accounts.
- Existing open positions need accounting review; the old format cannot prove whether their separately-written stake and payout were committed.
- This is a targeted loading/settlement repair, not a complete redesign or security audit of the legacy wallet, deposits, withdrawals and administrator controls.

## Architecture checked in the migration

Placement, reservation and ledger insertion share a transaction. The server fixes start/expiry, allowed pairs and duration rates. The worker validates exact one-second candle timestamps, then changes status, credits cash, records one payout and updates history in the same transaction. Profile locks precede contract locks. A unique payout index is a second defense against duplicate credits. Browser roles cannot write canonical contracts/ledger or execute quote/payout helpers. Network failures retry original historical timestamps. Missing entry pricing cancels with a full refund; missing exit pricing waits for a valid quote.

Private helpers never use the legacy profit-mode flag. Both real and demo interfaces now identify that flag as practice-only.

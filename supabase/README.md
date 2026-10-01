# Database setup

Run **INSTALL.sql** as a complete script in Supabase SQL Editor, then deploy the website files. See **../README-FIRST.md**.

- `repair-auth-realtime.sql`: existing auth/profile/support setup, included first in INSTALL.sql.
- `repair-performance-settlement.sql`: new atomic contracts, ledger, quote queue, five-second pg_cron worker, legacy review migration and attachment cleanup, included second in INSTALL.sql.
- `test-settlement.sql`: staging integration assertions; all fixture data rolls back.
- `check-settlement.sql`: read-only health, credit, history and review diagnostics.

Do not install only the old schema or retired partial repairs. Never expose a service-role key in the browser.

The worker's quote processor and payout functions are inaccessible to browser roles. Browser RPCs accept only order intent or a contract ID. Trusted functions own balance changes and compatibility history rows. Canonical contract and ledger tables grant authenticated SELECT only, with ownership/admin RLS. The compatibility rows use the existing realtime publication, so account/admin pages refresh after changes.

Official interface references consulted during repair:
- https://supabase.com/docs/guides/cron/quickstart
- https://supabase.com/docs/guides/database/extensions/pg_net
- https://developers.binance.com/en/docs/products/spot/rest-api
- https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/market

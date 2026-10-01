# Verify the deployed repair

Use a staging Supabase project or a dedicated test account and test balance.

1. Install `supabase/INSTALL.sql`. Run `supabase/test-settlement.sql` in staging. It should report passing assertions and roll back its fixtures. This test uses fixture quotes and does not validate market connectivity.
2. Deploy the complete website. Close previous tabs and hard-refresh. Confirm login/signup and admin user visibility still work.
3. Open dashboard, assets, markets, trade, history, demo and settings. Navigation should appear while account data loads. Check desktop and mobile layouts. In developer tools Network, there should be no Tailwind compiler or remote Lucide request; fonts should not hold up rendering. Database requests should be limited by page and user.
4. With a dedicated test account, note available cash. Place a BTC five-minute contract for 200 using a 1,000 test balance. Wait for “Trade accepted” and the server entry price. Cash should be 800; assets should show 200 held in USDT, not 200 BTC.
5. Close **all** customer and admin website tabs before expiry. After expiry plus roughly 15 seconds, run `supabase/check-settlement.sql` in SQL Editor, without reopening a website page. Confirm the contract is Won, Lost or Draw and has a settlement timestamp and exactly two ledger entries. Verify 1,060 for a win, 940 for a loss, or 1,000 for a draw. The public market determines which result occurs.
6. Reopen dashboard/history/admin. Confirm the same status and balance. Reload and use a second tab: there must be no further payout. Check the original trade disappeared from open positions.
7. Test a disconnected/lost order response in staging. Retry identical details. Confirm one reservation and one contract. Insufficient funds or invalid amounts must not change cash.
8. Check early closure, equal-price fixture cases, unavailable entry refunds and unavailable exit retries with the SQL regression fixtures/staging controls. Do not block real users' feeds to test this.
9. Confirm support requests, chat, attachment opening, wallet transfers and admin changes on your deployed schema. Concurrent profile edits should show a conflict instead of overwriting a background credit.

If a trade remains Settling, inspect `trade_quote_jobs.error` using the diagnostic script. Confirm `trade_worker_health.last_run` advances. A blocked Binance endpoint, rate limit, disabled extension, paused project or inactive Cron job needs operational correction. The worker retries exact historical prices; reopening the trade page should never manufacture a result.

Old Review positions require reconciliation. No automatic credit or new deduction is made for them by the migration.

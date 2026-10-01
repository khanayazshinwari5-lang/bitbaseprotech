# Install the loading and automatic settlement repair

1. In your Supabase project, open **SQL Editor** and run the entire **`supabase/INSTALL.sql`** file. It includes the previous authentication repair and the new trade engine. It installs a database job named `bitbase-contract-worker` that runs every five seconds. If extension creation is refused, enable **pg_cron** and **pg_net** under Database → Extensions, then rerun the file.
2. Upload the contents of this `bitbasepro.org` folder over your existing website and redeploy. Keep your existing public Supabase connection in `assets/js/supabase-config.js`. No private key or separate server deployment is needed.
3. Close old website tabs and hard-refresh the updated site. Run `supabase/check-settlement.sql`, then follow **LIVE-CHECK.md** with a dedicated test account.

**Uploading website files alone does not activate automatic settlement. The SQL installation is required.** The repair has not been applied to your hosted Supabase project in this session.

## What changed

- Local CSS replaces the blocking Tailwind browser compiler. Icons are included locally, and fonts load without holding up the page.
- Dashboard, assets, markets, trade, history, demo and settings request their own data. Opening a normal page as an administrator no longer downloads every customer's profiles and history.
- Removed duplicate startup profile reads, repeating refresh loops and unnecessary whole-database polls. A slow quote provider now has an overlapping backup. Old request attachments are moved into separately fetched records by the SQL migration.
- Real trades reserve cash and create the contract in one transaction. Retries reuse the same order ID. Closing the browser after acceptance cannot lose the contract.
- PostgreSQL retrieves historical one-second Binance USDT candles and settles the recorded expiry, even with nobody signed in. A delayed job uses the original expiry price, not the price when a customer returns.
- Settlement, balance credit, the ledger, history and the admin projection commit together. Row locks and a unique payout entry prevent duplicate credits. Stale profile writes are rejected instead of overwriting a settlement credit.
- The assets table now shows reserved stakes as USDT, and available cash is not reduced twice. Dashboard total includes held stakes.
- Demo positions/history persist separately. Admin “Demo Profit Mode” only affects practice results; real results follow the recorded prices.

## Payout rules retained and clarified

For a $200 five-minute trade at 30%, starting with $1,000:

| Event | Available cash | Amount returned | Net result |
| --- | ---: | ---: | ---: |
| Accepted | $800 | — | $200 held |
| Win | $1,060 | $260 | +$60 |
| Loss | $940 | $140 | −$60 |
| Equal entry/exit price | $1,000 | $200 | $0 |
| Early close after entry confirmed | $900 | $100 | −$100 |

The entry is the close of the one-second candle ending at the server's scheduled start, approximately two seconds after acceptance. The exit is the corresponding close at expiry. An accepted order initially shows “Confirming...” for entry. An order with no confirmed entry after 60 seconds is cancelled and refunded fully. If the exit price is unavailable, it remains “Settling...” and retries; it is never decided using zero, a made-up quote, or a forced win.

The scheduler checks every five seconds and processes network responses on a later tick. Normal credits may appear around 5–15 seconds after expiry, depending on the network and workload. Outages can take longer. Historical quotes keep the result tied to expiry. The SQL health check shows pending requests and errors.

## Important limits

- New real contracts support BTC, ETH, BNB, SOL, XRP, ADA, DOGE, AVAX, LINK, TRX, DOT and LTC against USDT. Forex, metals and commodities remain available in Demo; their previous quote sources do not supply the required expiry history. This is an internal duration-contract ledger, not order execution on Binance.
- Old open positions are marked **Review**. The previous code wrote stake deduction and payout separately, so it cannot prove whether either already happened. Their cash balances are left unchanged. Unverified Review amounts are excluded from portfolio totals until reconciled. Reconcile the original debit and any previous payout before using the SQL-editor-only `bb_resume_verified_legacy(id)` function. Do not call it merely to clear the review label. Unsupported pairs or already-paid positions require a manual accounting decision.
- Demo remains browser-driven: practice trades settle while a page is running or after reopening. It does not use real cash.
- The broader deposit/withdrawal/account-adjustment code still uses the original wallet design. This repair adds conflict protection but is not a complete server-side wallet or security redesign.

## Validation

`npm test` runs the dependency-free JavaScript regression suite. **TEST-REPORT.md** lists the results and limits. `supabase/test-settlement.sql` contains transaction/ledger assertions for a staging Supabase project and rolls back its fixture data. It was not executed here because database access is unavailable. Live scheduler, market access, RLS and browser visual checks still require deployment verification.

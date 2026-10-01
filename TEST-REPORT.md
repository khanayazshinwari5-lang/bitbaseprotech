# Test report — 2026-10-01

## Result

**23 automated local tests passed; 0 failed.** In addition, all 33 application
JavaScript files/inline script blocks passed Node syntax checks. Local HTML
asset references were checked, and the two standalone SQL entry points were
confirmed identical. The exact automated run is in `TEST-RESULTS.txt`.

The tests run the actual `db.js`, `auth.js`, login/signup form scripts and
protected-page startup scripts. Supabase is replaced with an explicit test
double that models v2 response shapes, database state, multiple client sessions,
permissions, events and connection failures. No production users or messages
were created. Form/startup tests use DOM stubs; they are not rendered-browser
visual tests.

| Area | Verified locally |
|---|---|
| Session restoration | Reads `data.session`; handles `(event, session)` auth callbacks and token refresh |
| Signup and login | Waits for boot; creates/loads server profiles; preserves balances/KYC on login |
| Confirmation | Shows successful pending signup without claiming the user is signed in |
| Invalid/offline login | Displays failure, releases the form spinner, and creates no local ghost account |
| Orphaned accounts | Calls the caller-scoped repair RPC; surfaces profile policy errors |
| New admin users list | Newly registered ordinary user appears in a separate admin session |
| Requests | Deposit, withdrawal, borrow and KYC requests reach the admin mirror; status updates return to the customer |
| Persistence | Flush waits for actual writes; failed requests stay queued and can be retried |
| Concurrent customers | New rows from another customer are retained rather than deleted by stale collection writes |
| Customer support | User message reaches admin; admin reply and subsequent customer image/message sync back |
| Message ownership | Admin replies retain the customer's thread owner; unrelated customer sees no conversation in the modeled policy |
| Retry after commit | A lost acknowledgement does not duplicate a message on retry |
| Admin edits | Account-map edits persist to the intended server profile |
| Logout | Clears prior account data and restores only the next account's permitted rows |
| Pagination | Admin can load 1,003 profiles across multiple result pages |
| Poll fallback | Data recovers without realtime event delivery through the four-second refresh path |
| Disabled accounts | Cannot complete the login flow |
| Protected pages | Dashboard, Assets, Markets, History, Settings and Trade wait for session readiness |
| Auth form scripts | Invalid-login feedback, valid-login redirect and signup-confirmation feedback |

## Bugs corrected

- `getSession()` was treated as `{session}` instead of `{data:{session}}`.
- The auth-change event name was mistaken for the session object.
- Supabase SDK boot raced form submissions and protected-page redirects.
- Database mirror objects/arrays were incorrectly passed through `JSON.parse`,
  causing valid users, requests and chat records to appear empty.
- Normal customers were excluded from support writes by a browser-side admin flag.
- There were no Postgres change subscriptions; existing timers only reread the
  same unchanged browser mirror.
- The old flush function cancelled pending writes without sending them.
- Several queries checked for errors before the query resolved, hiding failures.
- Whole-collection writes could delete unseen requests or conversations.
- An admin reply could overwrite a thread's customer ownership.
- Message inserts did not retain stable IDs, enabling duplicates after resaves.
- Profile-map edits were not consistently routed to the database.
- The Markets script referenced an undefined auth variable during startup.
- Old SQL repairs referenced a nonexistent timestamp column, suppressed trusted
  profile updates, or risked making multiple orphaned accounts owners.

## Live work still required

The configured Supabase health request timed out from this environment. The
archive contains a public client key, not database migration access. Therefore:

- The SQL repair was reviewed but not executed against PostgreSQL/Supabase here.
- Actual production RLS, project settings, realtime publication, email delivery,
  cross-device latency and deployed-page rendering remain unverified.
- The website files have not been deployed.

Run `README-FIRST.md` and then `LIVE-CHECK.md`. Existing account/profile IDs and
roles are preserved. Any new admin role must be explicitly granted to the
intended account by the project owner.

This repair covers authentication, request visibility and support messaging.
It is not a full audit of the existing client-driven financial operations,
trade settlement, payment processing or production financial security.

# Check the deployed project

Use separate browser profiles for the admin and customer. Separate normal tabs
share one Supabase login and will switch accounts together.

1. Run the repair SQL, then deploy these website files. Confirm its final query
   reports `missing_profiles = 0` and lists profiles, request_rows,
   support_threads, support_messages, app_settings and user_settings in the
   `supabase_realtime` publication.
2. Sign in as your existing admin. Open **Users**. Keep that screen open.
3. Register an account using an email you control in a private window. If email
   confirmation is enabled, confirm it and then sign in. The admin user list
   should update automatically. Confirm its email and UUID match the profile.
4. Log out of the customer account and sign in again. Reload Dashboard, Assets,
   Markets, History and Settings. They should remain signed in after session
   restoration and show that account's own data.
5. Using clearly identified test data in a staging project, submit a deposit
   request. Do not transfer actual money for this test. Keep the admin Deposits
   view open and verify the request arrives with the correct customer and amount.
   Repeat with withdrawal, loan and KYC requests only in staging where their
   prerequisites can be safely met. Verify each corresponding admin queue.
6. From **Assets → Support**, send a unique message. Verify its text and customer
   in **Admin → Support** without manually refreshing. Reply from admin and
   verify it appears in the customer panel. Repeat with a small image, a second
   message and a resolved/reopened conversation. Each message should appear once.
7. Keep an unsent reply in the admin composer while the customer sends a new
   message. The draft should remain intact and the incoming message should show.
8. Open a second unrelated customer session. Confirm it cannot see the first
   customer's requests or conversations, and cannot access the admin panel.
9. In staging, switch the customer's network offline, send a message, and verify
   a delivery error is shown. Restore the connection and use Retry if needed.
   Confirm exactly one copy arrives. Keep the tab open until it is saved.

Realtime is normally event-driven. If realtime cannot connect, visible pages
refresh on a four-second fallback interval. Longer delays or errors in the
connection notice require checking the project's network, RLS and publication.

This checklist remains to be run against your live/staging Supabase project;
the included automated results are not a claim that these live checks passed.

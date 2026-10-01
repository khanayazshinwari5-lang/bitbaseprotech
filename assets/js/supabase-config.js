/* ==========================================================================
   Bitbase – Supabase connection settings

   Fill these two values in, then upload the folder to Vercel (or run it
   locally). Project URL + anon key: Supabase -> Settings -> API.

   The anon key is designed to be public - every row this app touches is
   guarded by the row level security policies in supabase/schema.sql, which
   is what actually decides who may read or write what. Never put the
   service_role key in here: that one bypasses RLS entirely.
   ========================================================================== */
window.BITBASE_CONFIG = {
  supabaseUrl: 'https://wlelewblftgwlddcvmec.supabase.co/rest/v1/,
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndsZWxld2JsZnRnd2xkZGN2bWVjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA4NTQ4ODYsImV4cCI6MjEwNjQzMDg4Nn0.DjhcIV2PduG6IX271FnZygprdyk2mhExNn1wrPdU948,

  // Turn this off to fall back to the old browser-only storage. Useful when you
  // want to demo offline, or while you are still filling in the two values
  // above - the site keeps working, it just stops syncing to the database.
  useSupabase: true
};
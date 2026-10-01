/* ==========================================================================
   Bitbase – Supabase connection settings

   Project Settings -> API. Two values:

     supabaseUrl     the project URL and nothing else - NOT the REST path.
                     Supabase's client appends /rest/v1 and /auth/v1 itself,
                     so pasting "...supabase.co/rest/v1/" makes every request
                     404 and the site silently falls back to local storage.
     supabaseAnonKey the anon/public key, which is designed to be visible in
                     the browser: every row this app touches is gated by the row
                     level security policies in supabase/schema.sql. Never put
                     the service_role key here - it bypasses RLS entirely.
   ========================================================================== */
window.BITBASE_CONFIG = {
  supabaseUrl: 'https://wlelewblftgwlddcvmec.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndsZWxld2JsZnRnd2xkZGN2bWVjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA4NTQ4ODYsImV4cCI6MjEwNjQzMDg4Nn0.DjhcIV2PduG6IX271FnZygprdyk2mhExNn1wrPdU948',

  // Set to false to run entirely on browser storage. Useful for offline demos.
  useSupabase: true
};
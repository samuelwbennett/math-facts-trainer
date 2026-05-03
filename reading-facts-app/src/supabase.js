// Supabase client for the reading app.
//
// This points at the SAME Supabase project as the math facts app, so
// VPA students who already have an account can sign in here too.
//
// The anon key is safe to expose: it grants only the access defined by
// the database's row-level-security policies. The "real" secrets live
// on the server.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://dtkrnyberbpfdmikpdnw.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR0a3JueWJlcmJwZmRtaWtwZG53Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4MDE0MzIsImV4cCI6MjA5MzM3NzQzMn0.oElhVtcEbq8nDBBFzpsTdfDcSGO1b6TLBclKFxBAUC8";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,        // remember the session in localStorage
    autoRefreshToken: true,      // refresh the token before it expires
    detectSessionInUrl: true,    // handle the magic-link callback in the URL
  },
});

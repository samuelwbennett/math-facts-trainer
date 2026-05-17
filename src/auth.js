import { useState, useEffect } from "react";
import { supabase } from "./supabase";

// Reading-academy's /api/provision-self — idempotently creates a
// user_profiles row on first sign-in. Bridges Math Facts onto the
// orchestration layer's unified role model without any data
// migration. Fire-and-forget: if it fails, the app still works,
// the next sign-in retries.
const PROVISION_SELF_URL =
  "https://reading-academy.vercel.app/api/provision-self";

async function provisionSelfQuiet(session) {
  if (!session?.access_token) return;
  try {
    await fetch(PROVISION_SELF_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: "{}",
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[auth] provision-self failed (non-blocking):", err);
  }
}

// React hook: returns { session, loading } and re-renders on auth changes.
export function useAuth() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session);
      setLoading(false);
      if (data.session) provisionSelfQuiet(data.session);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, newSession) => {
      if (!mounted) return;
      setSession(newSession);
      if (newSession) provisionSelfQuiet(newSession);
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  return { session, loading };
}

// Sends a one-time login link to the email address.
export async function signInWithMagicLink(email) {
  return supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin },
  });
}

export async function signOut() {
  return supabase.auth.signOut();
}

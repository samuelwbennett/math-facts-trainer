// Tiny wrappers around Supabase auth so the rest of the app
// doesn't need to know about Supabase directly.

import { supabase } from "./supabase.js";

// Returns the current session ({ user, ... }) or null if signed out.
// On initial load, also fires provision-self so a user_profiles row
// exists for the signed-in user (same bridge as onAuthChange below).
export async function getSession() {
  const { data } = await supabase.auth.getSession();
  if (data.session) provisionSelfQuiet(data.session);
  return data.session;
}

// Subscribe to auth changes (sign in, sign out, token refresh).
// Pass a callback (newSession) => { ... }. Returns an unsubscribe fn.
//
// Side effect: on every sign-in or token refresh we call
// /api/provision-self so a user_profiles row exists for the
// signed-in user. Bridges reading-facts onto the orchestration
// layer's unified role model without any data migration.
export function onAuthChange(callback) {
  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange((_event, newSession) => {
    callback(newSession);
    if (newSession) provisionSelfQuiet(newSession);
  });
  return () => subscription.unsubscribe();
}

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

// Send the user a one-time magic-link email.
// They click the link → return to the app already signed in.
// Subject to Supabase's email rate limit.
export async function signInWithMagicLink(email) {
  return supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin + window.location.pathname },
  });
}

// Sign in with email + password. No email is sent, so this bypasses
// Supabase's email rate limit entirely.
export async function signInWithPassword(email, password) {
  return supabase.auth.signInWithPassword({ email, password });
}

// Create a new account with email + password.
// If "Confirm email" is OFF in Supabase (Auth → Providers → Email),
// this returns a session immediately and the user is signed in.
// If "Confirm email" is ON (default), Supabase sends a confirmation
// email — and that uses your email rate limit.
export async function signUpWithPassword(email, password) {
  return supabase.auth.signUp({ email, password });
}

export async function signOut() {
  return supabase.auth.signOut();
}

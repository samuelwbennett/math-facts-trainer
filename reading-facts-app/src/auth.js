// Tiny wrappers around Supabase auth so the rest of the app
// doesn't need to know about Supabase directly.

import { supabase } from "./supabase.js";

// Returns the current session ({ user, ... }) or null if signed out.
export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

// Subscribe to auth changes (sign in, sign out, token refresh).
// Pass a callback (newSession) => { ... }. Returns an unsubscribe fn.
export function onAuthChange(callback) {
  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange((_event, newSession) => {
    callback(newSession);
  });
  return () => subscription.unsubscribe();
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

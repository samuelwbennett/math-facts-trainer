// =====================================================
// Session bridge — silent cross-app sign-in.
//
// When the user launches Math Facts from the VPA orchestration
// layer's "Start Now" button, the orchestration layer appends
// `#vpa_session=<base64>` to the URL. The encoded payload contains
// the user's Supabase access + refresh tokens.
//
// This module:
//   1. Checks for the fragment on app boot.
//   2. Decodes + calls supabase.auth.setSession() to silently
//      sign the user in (no email magic link, no re-typing
//      credentials).
//   3. Cleans the fragment from the URL so the token doesn't
//      sit visible in the address bar or browser history.
//   4. Returns a Promise so main.jsx can await it before mounting
//      React (avoids the "render once signed-out, then re-render
//      signed-in" flicker).
//
// If no fragment is present, this is a no-op.
// See vpa-orchestration-layer/src/utils/launch.js for the producer.
// =====================================================

import { supabase } from "./supabase.js";

const FRAGMENT_PREFIX = "vpa_session=";

export async function consumeSessionFragment() {
  if (typeof window === "undefined") return;
  const hash = window.location.hash;
  if (!hash) return;

  // Hash can be "#vpa_session=...&foo=bar" or just "#vpa_session=...".
  const params = new URLSearchParams(hash.slice(1));
  const encoded = params.get("vpa_session");
  if (!encoded) return;

  try {
    const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(padBase64(b64));
    const payload = JSON.parse(json);
    if (payload?.access_token && payload?.refresh_token) {
      await supabase.auth.setSession({
        access_token: payload.access_token,
        refresh_token: payload.refresh_token,
      });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[sessionBridge] failed to consume #vpa_session:", err);
  } finally {
    // Always strip the fragment regardless of success, so a malformed
    // payload doesn't sit in the URL forever.
    params.delete("vpa_session");
    const remaining = params.toString();
    const newUrl =
      window.location.pathname +
      window.location.search +
      (remaining ? `#${remaining}` : "");
    window.history.replaceState(null, "", newUrl);
  }
}

function padBase64(s) {
  const pad = s.length % 4;
  return pad ? s + "=".repeat(4 - pad) : s;
}

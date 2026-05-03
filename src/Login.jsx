import { useState } from "react";
import { signInWithMagicLink } from "./auth";

export function Login() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState("idle"); // idle | sending | sent | error
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    if (!email || status === "sending") return;
    setStatus("sending");
    setError("");
    const { error: err } = await signInWithMagicLink(email.trim());
    if (err) {
      setStatus("error");
      setError(err.message || "Could not send the link. Try again.");
    } else {
      setStatus("sent");
    }
  }

  if (status === "sent") {
    return (
      <main className="app">
        <div className="card auth-card">
          <div className="brand-mark">VPA</div>
          <h1 className="auth-title">Check your email</h1>
          <p className="auth-subtitle">
            We sent a sign-in link to <strong>{email}</strong>. Tap it on this
            device to continue.
          </p>
          <button
            type="button"
            className="secondary-btn auth-restart"
            onClick={() => {
              setStatus("idle");
              setEmail("");
            }}
          >
            Use a different email
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="app">
      <div className="card auth-card">
        <div className="brand-mark">VPA</div>
        <h1 className="auth-title">Sign in</h1>
        <p className="auth-subtitle">
          We'll email you a one-time link. No password required.
        </p>
        <form onSubmit={handleSubmit}>
          <input
            type="email"
            placeholder="parent@email.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
            className="auth-input"
            autoComplete="email"
          />
          <button
            type="submit"
            className="primary-btn auth-submit"
            disabled={status === "sending"}
          >
            {status === "sending" ? "Sending..." : "Send sign-in link"}
          </button>
          {error && <div className="auth-error">{error}</div>}
        </form>
      </div>
    </main>
  );
}

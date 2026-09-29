// The SPA's own login gate. There is no server-rendered login page (the
// server exposes only `POST /api/login`), and the shell is served
// statically regardless of session state (static.ts), so a dead session
// used to mean every screen kept fetching, every fetch 401'd, and nothing
// ever told the user why the app had gone blank. `App.tsx` renders this
// in place of the shell the moment ANY `api.*` call comes back 401
// (`lib/errors.ts`'s `isSessionExpired`).
import { useState } from "preact/hooks";
import type { JSX } from "preact";
import type { Api } from "../lib/api";
import { ApiError } from "../lib/api";

export interface LoginProps {
  api: Api;
  /** Called after a successful `POST /api/login`. `App.tsx` reloads the
   *  page rather than trying to resume every in-flight fetch/effect from
   *  wherever they died -- simpler, and correct: a fresh session cookie
   *  plus a fresh mount is exactly the state the app would be in from a
   *  cold load anyway. */
  onSuccess: () => void;
}

export function Login({ api, onSuccess }: LoginProps): JSX.Element {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function handleSubmit(e: JSX.TargetedEvent<HTMLFormElement>): void {
    e.preventDefault();
    if (submitting || password.length === 0) return;
    setSubmitting(true);
    setError(null);
    api
      .login(password)
      .then(() => onSuccess())
      .catch((err: unknown) => {
        setSubmitting(false);
        setError(
          err instanceof ApiError
            ? err.status === 429
              ? "Too many attempts -- wait a bit and try again."
              : "That password didn't work."
            : "Couldn't reach the server. Check your connection and try again.",
        );
      });
  }

  return (
    <div
      data-testid="login-gate"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg)",
      }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "12px",
          width: "min(320px, 90vw)",
          padding: "24px",
          background: "var(--panel)",
          border: "1px solid var(--line)",
          borderRadius: "var(--radius-lg)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span aria-hidden="true" style={{ display: "inline-block", width: "20px", height: "20px", background: "#000000" }} />
          <span style={{ fontWeight: 600 }}>Wilco</span>
        </div>
        <p data-testid="login-message" style={{ margin: 0, color: "var(--muted)", fontSize: "13px" }}>
          Your session ended. Sign in again to keep reading mail.
        </p>
        <input
          type="password"
          data-testid="login-password"
          placeholder="Password"
          autoFocus
          value={password}
          onInput={(e) => setPassword(e.currentTarget.value)}
          style={{
            font: "inherit",
            padding: "8px 10px",
            color: "var(--ink)",
            background: "var(--panel2)",
            border: "1px solid var(--line)",
            borderRadius: "var(--radius-md)",
          }}
        />
        {error !== null && (
          <div data-testid="login-error" style={{ color: "var(--danger)", fontSize: "12px" }}>
            {error}
          </div>
        )}
        <button
          type="submit"
          data-testid="login-submit"
          disabled={submitting || password.length === 0}
          style={{
            font: "inherit",
            padding: "8px 10px",
            color: "var(--accent-ink)",
            background: "var(--accent)",
            border: "none",
            borderRadius: "var(--radius-md)",
            cursor: submitting || password.length === 0 ? "default" : "pointer",
            opacity: submitting || password.length === 0 ? 0.6 : 1,
          }}
        >
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

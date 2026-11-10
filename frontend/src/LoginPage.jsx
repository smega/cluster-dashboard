import { h } from 'preact';
import { useState } from 'preact/hooks';

const API_BASE = ''; // same origin

export default function LoginPage({ onLoggedIn }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch(`${API_BASE}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || 'Login failed');
      }

      const data = await res.json();
      if (data.token) {
        onLoggedIn(data.token);
      } else {
        throw new Error('Invalid response from server');
      }
    } catch (err) {
      console.error(err);
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div class="min-h-screen flex items-center justify-center bg-slate-100">
      <div class="w-full max-w-md">
        <div class="mb-6 text-center">
          <div class="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-500 shadow-sm">
            <span class="h-2 w-2 rounded-full bg-emerald-500" />
            <span class="font-mono">cluster-dashboard</span>
            <span class="text-slate-300">·</span>
            <span class="font-mono">v0.1.0</span>
          </div>
        </div>

        <div class="rounded-2xl border border-slate-200 bg-white/90 p-8 shadow-sm shadow-slate-200">
          <h1 class="text-2xl font-semibold text-slate-900 mb-2">
            Sign in
          </h1>
          <p class="text-sm text-slate-500 mb-6">
            Enter your credentials to access the cluster dashboard.
            Users are managed manually (no self-signup).
          </p>

          {error && (
            <div class="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {error}
            </div>
          )}

          <form class="space-y-4" onSubmit={handleSubmit}>
            <div>
              <label class="block text-sm font-medium text-slate-800 mb-1">
                Email
              </label>
              <input
                type="email"
                class="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/80 focus:border-emerald-500/80"
                value={email}
                onInput={(e) => setEmail(e.target.value)}
                required
                autoComplete="username"
              />
            </div>

            <div>
              <label class="block text-sm font-medium text-slate-800 mb-1">
                Password
              </label>
              <input
                type="password"
                class="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/80 focus:border-emerald-500/80"
                value={password}
                onInput={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              class="w-full inline-flex items-center justify-center rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-emerald-950 hover:bg-emerald-400 disabled:opacity-60 disabled:cursor-not-allowed transition-colors shadow-sm"
            >
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <div class="mt-6 border-t border-slate-100 pt-4">
            <p class="text-xs text-slate-400 font-mono">
              auth.mode = &quot;manual&quot;
              <span class="text-slate-300"> · </span>
              storage = &quot;mongodb&quot;
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

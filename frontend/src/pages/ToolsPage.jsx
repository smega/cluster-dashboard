// src/pages/ToolsPage.jsx
import { h } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { Link } from 'preact-router/match';

export default function ToolsPage({ tool }) {
  // Toasts (same pattern as other pages)
  const [toasts, setToasts] = useState([]);
  const pushToast = (type, message) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3500);
  };

  // --- JSON Pretty ---
  const [jsonIn, setJsonIn] = useState('');
  const [jsonOut, setJsonOut] = useState('');

  // --- Password generator ---
  const [pwLen, setPwLen] = useState(24);
  const [pwUpper, setPwUpper] = useState(true);
  const [pwLower, setPwLower] = useState(true);
  const [pwDigits, setPwDigits] = useState(true);
  const [pwSymbols, setPwSymbols] = useState(true);
  const [pwOut, setPwOut] = useState('');

  // --- “Password escaper” (common safe formats) ---
  const [escIn, setEscIn] = useState('');
  const escaped = useMemo(() => {
    const s = escIn || '';
    return {
      bashSingleQuoted: bashSingleQuote(s),
      yamlSingleQuoted: yamlSingleQuote(s),
      urlEncoded: encodeURIComponent(s),
    };
  }, [escIn]);

  useEffect(() => {
    // Nice default: show landing
    // tool is optional; no-op
  }, [tool]);

  const activeTool = (tool || '').toLowerCase(); // '' | 'json' | 'password' | 'escape' etc.

  const renderLanding = () => (
    <div class="space-y-4">
      <div class="flex items-center justify-between gap-2">
        <div>
          <h1 class="text-base font-semibold text-slate-900">Tools</h1>
          <p class="text-xs text-slate-500">
            Utilities that are not cluster / cloud specific.
          </p>
        </div>
      </div>

      <div class="grid gap-3 md:grid-cols-3">
        <ToolCard
          title="JSON pretty"
          desc="Format + validate JSON locally in the browser."
          href="/tools/json"
          badge="client-only"
        />
        <ToolCard
          title="Password generator"
          desc="Generate strong passwords with options."
          href="/tools/password"
          badge="client-only"
        />
        <ToolCard
          title="Password escaper"
          desc="Escape strings for bash/yaml + URL encode."
          href="/tools/escape"
          badge="client-only"
        />

        <ToolCard
          title="Cert check"
          desc="(Planned) Inspect TLS cert expiry, issuer, SANs."
          href="/tools/cert"
          badge="needs backend"
          disabled
        />
        <ToolCard
          title="Domain check"
          desc="(Planned) DNS/HTTP checks + light probing (safe)."
          href="/tools/domain"
          badge="needs backend"
          disabled
        />
      </div>

      <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div class="text-xs text-slate-600">
          Tip: This Tools area is intentionally separate from Ops. It won’t show your big Ops pill-nav.
        </div>
      </div>
    </div>
  );

  const renderJson = () => (
    <div class="space-y-4">
      <ToolsHeader title="JSON pretty" backHref="/tools" />
      <div class="grid gap-4 lg:grid-cols-2">
        <Card title="Input">
          <textarea
            class="w-full min-h-[280px] rounded-xl border border-slate-200 bg-white p-3 text-xs font-mono text-slate-800"
            value={jsonIn}
            onInput={(e) => setJsonIn(e.target.value)}
            placeholder='Paste JSON here…'
          />
          <div class="mt-3 flex items-center gap-2">
            <button
              type="button"
              class="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
              onClick={() => {
                try {
                  const obj = JSON.parse(jsonIn || 'null');
                  setJsonOut(JSON.stringify(obj, null, 2));
                  pushToast('success', 'Formatted JSON');
                } catch (e) {
                  pushToast('error', `Invalid JSON: ${String(e.message || e)}`);
                }
              }}
            >
              Format
            </button>
            <button
              type="button"
              class="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
              onClick={() => {
                setJsonIn('');
                setJsonOut('');
              }}
            >
              Clear
            </button>
          </div>
        </Card>

        <Card title="Output">
          <div class="rounded-xl border border-slate-200 bg-slate-950 p-3 min-h-[280px] overflow-auto">
            <pre class="text-[11px] text-slate-100 font-mono whitespace-pre-wrap break-words">
              {jsonOut || '—'}
            </pre>
          </div>
          <div class="mt-3">
            <button
              type="button"
              class="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(jsonOut || '');
                  pushToast('success', 'Copied output');
                } catch {
                  pushToast('error', 'Copy failed (clipboard blocked)');
                }
              }}
              disabled={!jsonOut}
            >
              Copy output
            </button>
          </div>
        </Card>
      </div>
    </div>
  );

  const renderPassword = () => (
    <div class="space-y-4">
      <ToolsHeader title="Password generator" backHref="/tools" />
      <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm space-y-3">
        <div class="grid gap-3 md:grid-cols-5">
          <div class="md:col-span-1">
            <label class="block text-[11px] text-slate-500 mb-1">Length</label>
            <input
              type="number"
              min="6"
              max="128"
              class="w-full rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs"
              value={pwLen}
              onInput={(e) => setPwLen(Math.max(6, Math.min(128, parseInt(e.target.value || '24', 10))))}
            />
          </div>
          <div class="md:col-span-4 flex flex-wrap items-end gap-3">
            <Toggle checked={pwUpper} onChange={setPwUpper} label="Uppercase" />
            <Toggle checked={pwLower} onChange={setPwLower} label="Lowercase" />
            <Toggle checked={pwDigits} onChange={setPwDigits} label="Digits" />
            <Toggle checked={pwSymbols} onChange={setPwSymbols} label="Symbols" />
          </div>
        </div>

        <div class="flex items-center gap-2">
          <button
            type="button"
            class="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
            onClick={() => {
              const pw = generatePassword(pwLen, {
                upper: pwUpper,
                lower: pwLower,
                digits: pwDigits,
                symbols: pwSymbols,
              });
              if (!pw) {
                pushToast('error', 'Select at least one character set.');
                return;
              }
              setPwOut(pw);
              pushToast('success', 'Generated password');
            }}
          >
            Generate
          </button>

          <button
            type="button"
            class="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(pwOut || '');
                pushToast('success', 'Copied password');
              } catch {
                pushToast('error', 'Copy failed (clipboard blocked)');
              }
            }}
            disabled={!pwOut}
          >
            Copy
          </button>
        </div>

        <div class="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
          <div class="text-[11px] text-slate-500 mb-1">Output</div>
          <div class="font-mono text-xs break-all text-slate-900">
            {pwOut || '—'}
          </div>
        </div>
      </div>
    </div>
  );

  const renderEscape = () => (
    <div class="space-y-4">
      <ToolsHeader title="Password escaper" backHref="/tools" />
      <div class="grid gap-4 lg:grid-cols-2">
        <Card title="Input">
          <input
            class="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-mono"
            value={escIn}
            onInput={(e) => setEscIn(e.target.value)}
            placeholder="Paste password/string…"
          />
          <div class="mt-2 text-[11px] text-slate-500">
            Useful when pasting into bash, YAML, or URLs.
          </div>
        </Card>

        <Card title="Escaped outputs">
          <KV label="Bash (single-quote safe)" value={escaped.bashSingleQuoted} onCopy={() => copy(escaped.bashSingleQuoted, pushToast)} />
          <KV label="YAML (single-quoted)" value={escaped.yamlSingleQuoted} onCopy={() => copy(escaped.yamlSingleQuoted, pushToast)} />
          <KV label="URL encoded" value={escaped.urlEncoded} onCopy={() => copy(escaped.urlEncoded, pushToast)} />
        </Card>
      </div>
    </div>
  );

  let body = null;
  if (!activeTool) body = renderLanding();
  else if (activeTool === 'json') body = renderJson();
  else if (activeTool === 'password') body = renderPassword();
  else if (activeTool === 'escape') body = renderEscape();
  else body = (
    <div class="space-y-3">
      <ToolsHeader title="Tools" backHref="/tools" />
      <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm text-xs text-slate-600">
        Unknown tool: <span class="font-mono">{tool}</span>
      </div>
    </div>
  );

  return (
    <>
      {body}

      {/* Toasts bottom-right */}
      <div class="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            class={
              'min-w-[220px] max-w-xs rounded-xl border px-3 py-2 text-xs shadow-md bg-white/95 backdrop-blur ' +
              (t.type === 'error'
                ? 'border-rose-200 text-rose-800'
                : t.type === 'success'
                ? 'border-emerald-200 text-emerald-800'
                : 'border-slate-200 text-slate-800')
            }
          >
            <div class="font-semibold mb-0.5">
              {t.type === 'error' ? 'Error' : t.type === 'success' ? 'Success' : 'Info'}
            </div>
            <div class="font-mono break-words">{t.message}</div>
          </div>
        ))}
      </div>
    </>
  );
}

function ToolsHeader({ title, backHref }) {
  return (
    <div class="flex items-center justify-between gap-2">
      <div>
        <h1 class="text-base font-semibold text-slate-900">{title}</h1>
        <p class="text-xs text-slate-500">Utilities area (separate from Ops)</p>
      </div>
      <Link
        href={backHref}
        class="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 shadow-sm"
      >
        ← Back
      </Link>
    </div>
  );
}

function ToolCard({ title, desc, href, badge, disabled }) {
  const inner = (
    <div class={'rounded-2xl border p-4 shadow-sm ' + (disabled ? 'border-slate-200 bg-slate-50 opacity-70' : 'border-slate-200 bg-white')}>
      <div class="flex items-center justify-between mb-1">
        <div class="text-sm font-semibold text-slate-900">{title}</div>
        {badge && (
          <span class="rounded-full border border-slate-200 bg-slate-100 px-2 py-0.5 text-[10px] font-mono text-slate-600">
            {badge}
          </span>
        )}
      </div>
      <div class="text-xs text-slate-500">{desc}</div>
      <div class="mt-3">
        <span class={'inline-flex items-center rounded-lg border px-2 py-1 text-[11px] ' + (disabled ? 'border-slate-200 text-slate-500' : 'border-slate-300 text-slate-700')}>
          Open
        </span>
      </div>
    </div>
  );

  if (disabled) return inner;

  return (
    <Link href={href} class="block">
      {inner}
    </Link>
  );
}

function Card({ title, children }) {
  return (
    <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm overflow-hidden">
      <div class="text-sm font-semibold text-slate-800 mb-2">{title}</div>
      {children}
    </div>
  );
}

function Toggle({ checked, onChange, label }) {
  return (
    <label class="inline-flex items-center gap-2 text-xs text-slate-700">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(!!e.target.checked)} />
      {label}
    </label>
  );
}

function KV({ label, value, onCopy }) {
  return (
    <div class="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 mb-2">
      <div class="flex items-center justify-between gap-2 mb-1">
        <div class="text-[11px] text-slate-500">{label}</div>
        <button
          type="button"
          class="rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-50"
          onClick={onCopy}
          disabled={!value}
        >
          Copy
        </button>
      </div>
      <div class="font-mono text-xs break-all text-slate-900">{value || '—'}</div>
    </div>
  );
}

function generatePassword(len, opts) {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%^&*()-_=+[]{};:,.?';

  let pool = '';
  const parts = [];
  if (opts.upper) { pool += upper; parts.push(upper); }
  if (opts.lower) { pool += lower; parts.push(lower); }
  if (opts.digits) { pool += digits; parts.push(digits); }
  if (opts.symbols) { pool += symbols; parts.push(symbols); }

  if (!pool) return '';

  // Ensure at least one from each selected set
  const out = [];
  for (const p of parts) out.push(p[Math.floor(Math.random() * p.length)]);

  while (out.length < len) out.push(pool[Math.floor(Math.random() * pool.length)]);

  // Shuffle
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.slice(0, len).join('');
}

// Bash single-quote safe string: wraps in '...' and escapes internal ' as '\''
// Example: abc'def -> 'abc'\''def'
function bashSingleQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// YAML single-quoted escape: single quote doubled inside single-quoted string
// Example: abc'def -> 'abc''def'
function yamlSingleQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

async function copy(text, pushToast) {
  try {
    await navigator.clipboard.writeText(text || '');
    pushToast('success', 'Copied');
  } catch {
    pushToast('error', 'Copy failed (clipboard blocked)');
  }
}

// src/pages/IngressesPage.jsx
import { h } from 'preact';
import { useState, useEffect, useMemo } from 'preact/hooks';

export default function IngressesPage({ token, user }) {
  const [ingresses, setIngresses] = useState([]);

  const [namespaceFilter, setNamespaceFilter] = useState(() => {
    if (typeof window === 'undefined') return 'all';
    return localStorage.getItem('ingresses_ns') || 'all';
  });
  const [search, setSearch] = useState('');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadTick, setReloadTick] = useState(0);

  const [selected, setSelected] = useState(null);

  const [toasts, setToasts] = useState([]);

  const isAdmin = (user?.role || '').toLowerCase() === 'admin'; // currently read-only, but we keep this for consistency

  const pushToast = (type, message) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  };

  // Persist namespace selection
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('ingresses_ns', namespaceFilter);
    }
  }, [namespaceFilter]);

  // Load ingresses
  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const res = await fetch('/api/ingresses', {
          headers: { Authorization: `Bearer ${token}` }
        });
        const text = await res.text();
        if (!res.ok) {
          let msg = text || 'Failed to load ingresses';
          try {
            const obj = JSON.parse(text);
            msg = obj.error || msg;
          } catch {}
          throw new Error(msg);
        }

        let data;
        try {
          data = JSON.parse(text);
        } catch {
          throw new Error('Invalid JSON from /api/ingresses');
        }

        if (cancelled) return;

        const items = Array.isArray(data.items) ? data.items : [];
        setIngresses(items);

        // Keep selection if it still exists
        if (selected) {
          const found = items.find(
            (i) => i.name === selected.name && i.namespace === selected.namespace
          );
          if (!found) {
            setSelected(null);
          }
        }
      } catch (err) {
        console.error('ingresses fetch failed', err);
        const msg = err.message || 'Failed to load ingresses';
        if (!cancelled) {
          setError(msg);
          setIngresses([]);
          setSelected(null);
          pushToast('error', msg);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, reloadTick]);

  // Clear selection if ns filter excludes it
  useEffect(() => {
    if (!selected) return;
    if (namespaceFilter !== 'all' && selected.namespace !== namespaceFilter) {
      setSelected(null);
    }
  }, [namespaceFilter, selected]);

  // Namespaces derived from ingresses
  const namespaces = useMemo(() => {
    const set = new Set(ingresses.map((i) => i.namespace));
    return Array.from(set).sort();
  }, [ingresses]);

  // Filtered ingresses
  const filtered = useMemo(() => {
    const ns = namespaceFilter;
    const q = search.trim().toLowerCase();

    return ingresses.filter((ing) => {
      if (ns && ns !== 'all' && ing.namespace !== ns) return false;
      if (!q) return true;

      const hosts =
        (ing.rules || [])
          .map((r) => r.host || '')
          .join(' ') || '';
      const text = `${ing.namespace}/${ing.name} ${ing.className || ''} ${hosts}`.toLowerCase();
      return text.includes(q);
    });
  }, [ingresses, namespaceFilter, search]);

  return (
    <>
      <section class="grid gap-4 lg:grid-cols-[2fr,1.3fr]">
        {/* Left: list */}
        <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div class="flex flex-wrap items-center justify-between gap-3 mb-3">
            <div>
              <h2 class="text-sm font-semibold text-slate-800">Ingresses</h2>
              <p class="text-xs text-slate-500">
                HTTP(S) entrypoints with backend validation.
              </p>
            </div>
            <div class="flex flex-wrap items-center gap-2 text-xs">
              <select
                class="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700"
                value={namespaceFilter}
                onChange={(e) => setNamespaceFilter(e.target.value)}
              >
                <option value="all">All namespaces</option>
                {namespaces.map((ns) => (
                  <option key={ns} value={ns}>
                    {ns}
                  </option>
                ))}
              </select>

              <input
                type="text"
                placeholder="Search name/host…"
                class="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 placeholder-slate-400"
                value={search}
                onInput={(e) => setSearch(e.target.value)}
              />

              <button
                type="button"
                class="rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-100"
                onClick={() => setReloadTick((r) => r + 1)}
              >
                Refresh
              </button>
            </div>
          </div>

          <div class="flex items-center justify-between mb-2 text-[11px] text-slate-500 font-mono">
            {loading ? (
              <span>loading ingresses…</span>
            ) : (
              <span>
                {filtered.length} shown / {ingresses.length} total
              </span>
            )}
          </div>

          {error && !loading && (
            <div class="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {error}
            </div>
          )}

          {!loading && !error && (
            <div class="overflow-x-auto">
              <table class="min-w-full text-xs border-separate border-spacing-y-[3px]">
                <thead>
                  <tr class="text-[11px] text-slate-500">
                    <th class="text-left font-medium px-2 py-1">Name</th>
                    <th class="text-left font-medium px-2 py-1">Namespace</th>
                    <th class="text-left font-medium px-2 py-1">Hosts</th>
                    <th class="text-left font-medium px-2 py-1">Backends</th>
                    <th class="text-left font-medium px-2 py-1">Class</th>
                    <th class="text-left font-medium px-2 py-1">Age</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((ing) => {
                    const hostList =
                      (ing.rules || [])
                        .map((r) => r.host || '')
                        .filter(Boolean);

                    const primaryHost = hostList[0] || '-';
                    const extraCount = Math.max(0, hostList.length - 1);

                    return (
                      <tr
                        key={`${ing.namespace}-${ing.name}`}
                        class={
                          'cursor-pointer bg-slate-50 hover:bg-slate-100 ' +
                          (selected &&
                          selected.namespace === ing.namespace &&
                          selected.name === ing.name
                            ? 'outline outline-1 outline-emerald-400/70'
                            : '')
                        }
                        onClick={() => setSelected(ing)}
                      >
                        <td class="px-2 py-1 align-top">
                          <div class="font-mono text-[11px] text-slate-800">
                            {ing.name}
                          </div>
                        </td>
                        <td class="px-2 py-1 align-top text-[11px] text-slate-600 font-mono">
                          {ing.namespace}
                        </td>
                        <td class="px-2 py-1 align-top text-[11px] text-slate-700">
                          <div class="flex flex-col gap-0.5">
                            <span class="font-mono text-[11px] text-slate-800">
                              {primaryHost}
                            </span>
                            {extraCount > 0 && (
                              <span class="text-[10px] text-slate-500">
                                +{extraCount} more
                              </span>
                            )}
                            {(!primaryHost || primaryHost === '-') &&
                              (ing.tlsHosts || []).length > 0 && (
                                <span class="text-[10px] text-slate-500">
                                  TLS: {(ing.tlsHosts || []).join(', ')}
                                </span>
                              )}
                          </div>
                        </td>
                        <td class="px-2 py-1 align-top text-[11px]">
                          <IngressBackendsBadge
                            backendsOK={ing.backendsOK}
                            missing={ing.missingBackends}
                          />
                        </td>
                        <td class="px-2 py-1 align-top text-[11px] text-slate-600 font-mono">
                          {ing.className || '-'}
                        </td>
                        <td class="px-2 py-1 align-top text-[11px] text-slate-600 font-mono">
                          {ing.age}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {filtered.length === 0 && (
                <div class="mt-3 text-xs text-slate-500">
                  No ingresses match the current filters.
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right: details */}
        <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div class="flex items-center justify-between mb-3">
            <div>
              <h2 class="text-sm font-semibold text-slate-800">
                Ingress details
              </h2>
              <p class="text-xs text-slate-500">
                Rules, TLS, backends, labels and annotations.
              </p>
            </div>
            {selected && (
              <div class="text-[11px] text-slate-500 font-mono text-right">
                {selected.namespace}/{selected.name}
              </div>
            )}
          </div>

          {!selected && (
            <div class="text-xs text-slate-500">
              No ingress selected. Click a row on the left to see details.
            </div>
          )}

          {selected && (
            <IngressDetailPanel ingress={selected} isAdmin={isAdmin} />
          )}
        </div>
      </section>

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
              {t.type === 'error'
                ? 'Error'
                : t.type === 'success'
                ? 'Success'
                : 'Info'}
            </div>
            <div class="font-mono break-words">{t.message}</div>
          </div>
        ))}
      </div>
    </>
  );
}

function IngressBackendsBadge({ backendsOK, missing }) {
  const hasMissing = !backendsOK && Array.isArray(missing) && missing.length > 0;
  if (hasMissing) {
    const label =
      missing.length === 1
        ? `missing: ${missing[0]}`
        : `${missing.length} missing services`;

    return (
      <span class="inline-flex items-center rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[10px] font-mono text-rose-700">
        {label}
      </span>
    );
  }

  return (
    <span class="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-mono text-emerald-700">
      backends ok
    </span>
  );
}

function IngressDetailPanel({ ingress }) {
  const labels = ingress.labels || {};
  const annotations = ingress.annotations || {};
  const rules = ingress.rules || [];
  const tlsHosts = ingress.tlsHosts || [];
  const defaultBackend = ingress.defaultBackend || null;

  return (
    <div class="space-y-4 text-xs">
      {/* Summary */}
      <div class="flex flex-wrap items-center gap-3">
        <span class="font-mono text-slate-600">
          class={ingress.className || '-'}
        </span>
        <span class="font-mono text-slate-600">
          age={ingress.age}
        </span>
        {tlsHosts.length > 0 && (
          <span class="font-mono text-slate-600">
            tls={tlsHosts.join(',')}
          </span>
        )}
        <IngressBackendsBadge
          backendsOK={ingress.backendsOK}
          missing={ingress.missingBackends}
        />
      </div>

      {/* Default backend + rules */}
      <div class="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 flex flex-col gap-2">
        {defaultBackend && defaultBackend.serviceName && (
          <div class="text-[11px] text-slate-700">
            <span class="font-mono text-slate-500">default:</span>{' '}
            <span class="font-mono text-slate-800">
              {defaultBackend.serviceName}
              {defaultBackend.servicePort
                ? `:${defaultBackend.servicePort}`
                : ''}
            </span>
          </div>
        )}

        <div class="space-y-2">
          {rules.map((r, idx) => (
            <div
              key={r.host || idx}
              class="rounded-lg border border-slate-200 bg-white px-3 py-2 flex flex-col gap-1"
            >
              <div class="flex items-center justify-between">
                <span class="font-mono text-[11px] text-slate-800">
                  host: {r.host || '*'}
                </span>
              </div>
              <div class="space-y-1">
                {(r.paths || []).map((p, i) => (
                  <div
                    key={`${p.path}-${i}`}
                    class="flex flex-wrap items-center gap-2"
                  >
                    <span class="font-mono text-[11px] text-slate-600">
                      path={p.path || '/'}
                    </span>
                    {p.pathType && (
                      <span class="font-mono text-[11px] text-slate-500">
                        ({p.pathType})
                      </span>
                    )}
                    {p.backend && p.backend.serviceName && (
                      <span class="font-mono text-[11px] text-slate-700">
                        svc={p.backend.serviceName}
                        {p.backend.servicePort
                          ? `:${p.backend.servicePort}`
                          : ''}
                      </span>
                    )}
                    {!p.backendOK && (
                      <span class="inline-flex items-center rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[10px] font-mono text-rose-700">
                        missing service
                      </span>
                    )}
                  </div>
                ))}
                {(!r.paths || r.paths.length === 0) && (
                  <div class="text-[11px] text-slate-500">
                    No HTTP paths.
                  </div>
                )}
              </div>
            </div>
          ))}
          {rules.length === 0 && (
            <div class="text-[11px] text-slate-500">
              No HTTP rules defined.
            </div>
          )}
        </div>
      </div>

      {/* Labels & annotations */}
      <div class="grid gap-4 md:grid-cols-2">
        <div>
          <h3 class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em] mb-1">
            Labels
          </h3>
          <KeyValueList obj={labels} emptyLabel="No labels." />
        </div>
        <div>
          <h3 class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em] mb-1">
            Annotations
          </h3>
          <KeyValueList obj={annotations} emptyLabel="No annotations." />
        </div>
      </div>
    </div>
  );
}

function KeyValueList({ obj, emptyLabel = 'None.' }) {
  const entries = Object.entries(obj || {});
  if (entries.length === 0) {
    return (
      <div class="text-[11px] text-slate-500">
        {emptyLabel}
      </div>
    );
  }
  return (
    <div class="space-y-1 text-[11px]">
      {entries.map(([k, v]) => (
        <div key={k} class="flex gap-1">
          <span class="font-mono text-slate-500">{k}=</span>
          <span class="font-mono text-slate-800 break-all">{String(v)}</span>
        </div>
      ))}
    </div>
  );
}

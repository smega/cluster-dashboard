import { h } from 'preact';
import { useState, useEffect, useMemo } from 'preact/hooks';
import { EventSourcePolyfill } from 'event-source-polyfill';

function parseQueryFromUrl(url) {
  try {
    const idx = (url || '').indexOf('?');
    const qs = idx >= 0 ? (url || '').slice(idx + 1) : '';
    const p = new URLSearchParams(qs);
    return {
      ns: p.get('ns') || '',
      q: p.get('q') || '',
    };
  } catch {
    return { ns: '', q: '' };
  }
}

export default function PodsPage({ token, user, url }) {
  const [pods, setPods] = useState([]);

  const [namespaceFilter, setNamespaceFilter] = useState(() => {
    if (typeof window === 'undefined') return 'all';
    return localStorage.getItem('pods_ns') || 'all';
  });
  const [search, setSearch] = useState('');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

  const [actionStatus, setActionStatus] = useState('');
  const [actionError, setActionError] = useState('');

  const [liveState, setLiveState] = useState('connecting'); // connecting | open | closed

  const isAdmin = (user?.role || '').toLowerCase() === 'admin';

  // Toasts (same style as deployments)
  const [toasts, setToasts] = useState([]);
  const pushToast = (type, message) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  };

  // Apply query params: /pods?ns=...&q=...
  useEffect(() => {
    const { ns, q } = parseQueryFromUrl(url || '');
    if (ns) setNamespaceFilter(ns);
    if (q) setSearch(q);
    // If q is empty, don’t overwrite user typing; only apply when provided.
  }, [url]);

  // Remember namespace
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('pods_ns', namespaceFilter);
    }
  }, [namespaceFilter]);

  // Initial load
  useEffect(() => {
    if (!token) return;

    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const res = await fetch('/api/pods', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          const txt = await res.text();
          throw new Error(txt || 'Failed to load pods');
        }
        const data = await res.json();
        if (!cancelled) {
          setPods(Array.isArray(data.items) ? data.items : []);
        }
      } catch (err) {
        console.error('pods fetch failed', err);
        if (!cancelled) {
          const msg = err.message || 'Failed to load pods';
          setError(msg);
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
  }, [token]);

  // Live SSE: /api/pods/stream
  useEffect(() => {
    if (!token) return;

    const es = new EventSourcePolyfill('/api/pods/stream', {
      headers: { Authorization: `Bearer ${token}` },
      heartbeatTimeout: 60000,
    });

    setLiveState('connecting');

    es.onopen = () => setLiveState('open');

    es.onerror = (err) => {
      console.warn('pods stream error', err);
      setLiveState('connecting'); // auto-reconnect
    };

    es.addEventListener('upsert', (evt) => {
      try {
        const p = JSON.parse(evt.data);
        setPods((prev) => {
          const idx = prev.findIndex((r) => r.namespace === p.namespace && r.name === p.name);
          if (idx === -1) return [...prev, p];
          const copy = prev.slice();
          copy[idx] = { ...copy[idx], ...p };
          return copy;
        });
      } catch (e) {
        console.error('bad pod upsert event', e);
      }
    });

    es.addEventListener('delete', (evt) => {
      try {
        const payload = JSON.parse(evt.data);
        const ns = payload.namespace;
        const name = payload.name;
        setPods((prev) => prev.filter((r) => !(r.namespace === ns && r.name === name)));
      } catch (e) {
        console.error('bad pod delete event', e);
      }
    });

    return () => {
      setLiveState('closed');
      es.close();
    };
  }, [token]);

  // Derived namespaces (and ensure selected ns is present)
  const namespaces = useMemo(() => {
    const set = new Set(pods.map((p) => p.namespace));
    if (namespaceFilter && namespaceFilter !== 'all') set.add(namespaceFilter);
    return Array.from(set).sort();
  }, [pods, namespaceFilter]);

  // Filter pods
  const filtered = useMemo(() => {
    const ns = namespaceFilter;
    const q = search.trim().toLowerCase();
    return pods.filter((p) => {
      if (ns && ns !== 'all' && p.namespace !== ns) return false;
      if (!q) return true;
      const text = `${p.namespace}/${p.name}`.toLowerCase();
      return text.includes(q);
    });
  }, [pods, namespaceFilter, search]);

  // Load pod details
  const handleSelect = async (p) => {
    setSelected(p);
    setDetail(null);
    setDetailError('');
    setDetailLoading(true);
    setActionStatus('');
    setActionError('');

    try {
      const res = await fetch(`/api/pods/${encodeURIComponent(p.namespace)}/${encodeURIComponent(p.name)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt || 'Failed to load pod detail');
      }
      const data = await res.json();
      setDetail(data);
    } catch (err) {
      console.error('pod detail fetch failed', err);
      const msg = err.message || 'Failed to load pod detail';
      setDetailError(msg);
      pushToast('error', msg);
    } finally {
      setDetailLoading(false);
    }
  };

  return (
    <>
      <section class="grid gap-4 lg:grid-cols-[2fr,1.3fr]">
        {/* Left: list */}
        <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div class="flex flex-wrap items-center justify-between gap-3 mb-3">
            <div>
              <h2 class="text-sm font-semibold text-slate-800">Pods</h2>
              <p class="text-xs text-slate-500">
                Live pod list with namespace filter (readonly).
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
                placeholder="Search name…"
                class="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 placeholder-slate-400"
                value={search}
                onInput={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>

          <div class="flex items-center justify-between mb-2 text-[11px] text-slate-500 font-mono">
            {loading ? <span>loading pods…</span> : <span>{filtered.length} shown / {pods.length} total</span>}
            <span>live={liveState}</span>
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
                    <th class="text-left font-medium px-2 py-1">Status</th>
                    <th class="text-left font-medium px-2 py-1">Ready</th>
                    <th class="text-left font-medium px-2 py-1">Restarts</th>
                    <th class="text-left font-medium px-2 py-1">Node</th>
                    <th class="text-left font-medium px-2 py-1">Age</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((p) => (
                    <tr
                      key={`${p.namespace}-${p.name}`}
                      class={
                        'cursor-pointer bg-slate-50 hover:bg-slate-100 ' +
                        (selected && selected.namespace === p.namespace && selected.name === p.name
                          ? 'outline outline-1 outline-emerald-400/70'
                          : '')
                      }
                      onClick={() => handleSelect(p)}
                    >
                      <td class="px-2 py-1 align-top">
                        <div class="font-mono text-[11px] text-slate-800">{p.name}</div>
                      </td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-600 font-mono">{p.namespace}</td>
                      <td class="px-2 py-1 align-top text-[11px]">
                        <PodStatusBadge status={p.status} phase={p.phase} />
                      </td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-700 font-mono">{p.ready}</td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-700 font-mono">{p.restarts}</td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-600 font-mono">{p.nodeName || '-'}</td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-600 font-mono">{p.age}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {filtered.length === 0 && (
                <div class="mt-3 text-xs text-slate-500">No pods match the current filters.</div>
              )}
            </div>
          )}
        </div>

        {/* Right: details */}
        <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div class="flex items-center justify-between mb-3">
            <div>
              <h2 class="text-sm font-semibold text-slate-800">Pod details</h2>
              <p class="text-xs text-slate-500">Summary, containers, labels, annotations and actions.</p>
            </div>
            {selected && (
              <div class="text-[11px] text-slate-500 font-mono">
                {selected.namespace}/{selected.name}
              </div>
            )}
          </div>

          {!selected && (
            <div class="text-xs text-slate-500">No pod selected. Click a row on the left to see details.</div>
          )}

          {selected && detailLoading && (
            <div class="text-xs text-slate-500 font-mono">loading pod detail…</div>
          )}

          {selected && detailError && !detailLoading && (
            <div class="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {detailError}
            </div>
          )}

          {selected && detail && !detailLoading && !detailError && (
            <PodDetailPanel
              detail={detail}
              isAdmin={isAdmin}
              actionStatus={actionStatus}
              actionError={actionError}
            />
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
              {t.type === 'error' ? 'Error' : t.type === 'success' ? 'Success' : 'Info'}
            </div>
            <div class="font-mono break-words">{t.message}</div>
          </div>
        ))}
      </div>
    </>
  );
}

function PodStatusBadge({ status, phase }) {
  const s = (status || phase || '').toLowerCase();
  let cls = 'bg-slate-100 text-slate-700 border-slate-200';
  if (s === 'running' || s === 'ready') {
    cls = 'bg-emerald-50 text-emerald-700 border-emerald-200';
  } else if (s.includes('crashloop') || s.includes('error') || s.includes('imagepull')) {
    cls = 'bg-rose-50 text-rose-700 border-rose-200';
  } else if (s === 'pending') {
    cls = 'bg-amber-50 text-amber-700 border-amber-200';
  }

  return (
    <span class={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-mono ${cls}`}>
      {status || phase || 'Unknown'}
    </span>
  );
}

function PodDetailPanel({ detail, isAdmin, actionStatus, actionError }) {
  const labels = detail.labels || {};
  const annotations = detail.annotations || {};
  const containers = detail.containers || [];

  return (
    <div class="space-y-4 text-xs">
      <div class="flex flex-wrap items-center gap-3">
        <PodStatusBadge status={detail.status} phase={detail.phase} />
        <span class="font-mono text-slate-600">node={detail.nodeName || '-'}</span>
        <span class="font-mono text-slate-600">podIP={detail.podIP || '-'}</span>
        <span class="font-mono text-slate-600">restarts={detail.restarts}</span>
        <span class="font-mono text-slate-600">age={detail.age}</span>
      </div>

      <div class="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 flex flex-col gap-2">
        <div class="flex items-center justify-between">
          <div class="text-[11px] text-slate-600 font-mono">
            mode={isAdmin ? '"admin"' : '"readonly"'}
          </div>
        </div>
        {actionStatus && <div class="text-[11px] text-emerald-700 font-mono">{actionStatus}</div>}
        {actionError && <div class="text-[11px] text-rose-700 font-mono">{actionError}</div>}
      </div>

      <div>
        <h3 class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em] mb-1">
          Containers
        </h3>
        <div class="space-y-2">
          {containers.map((c) => (
            <div
              key={c.name}
              class="rounded-lg border border-slate-200 bg-white px-3 py-2 flex flex-col gap-1"
            >
              <div class="flex items-center justify-between">
                <span class="font-mono text-[11px] text-slate-800">{c.name}</span>
                <span class="font-mono text-[11px] text-slate-600">restarts={c.restartCount}</span>
              </div>
              <div class="text-[11px] text-slate-500 break-all">
                image: <span class="font-mono">{c.image}</span>
              </div>
              <div class="text-[11px] text-slate-500">
                ready: <span class="font-mono">{c.ready ? 'true' : 'false'}</span>{' '}
                state: <span class="font-mono">{c.state || 'unknown'}</span>
              </div>
            </div>
          ))}
          {containers.length === 0 && <div class="text-[11px] text-slate-500">No containers.</div>}
        </div>
      </div>

      <div class="grid gap-4 md:grid-cols-2">
        <div>
          <h3 class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em] mb-1">
            Labels
          </h3>
          <KeyValueList obj={labels} />
        </div>
        <div>
          <h3 class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em] mb-1">
            Annotations
          </h3>
          <KeyValueList obj={annotations} />
        </div>
      </div>
    </div>
  );
}

function KeyValueList({ obj }) {
  const entries = Object.entries(obj || {});
  if (entries.length === 0) {
    return <div class="text-[11px] text-slate-500">None.</div>;
  }
  return (
    <div class="space-y-1 text-[11px]">
      {entries.map(([k, v]) => (
        <div key={k} class="flex gap-1">
          <span class="font-mono text-slate-500">{k}=</span>
          <span class="font-mono text-slate-800 break-all">{v}</span>
        </div>
      ))}
    </div>
  );
}

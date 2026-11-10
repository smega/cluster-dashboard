import { h } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { EventSourcePolyfill } from 'event-source-polyfill';

export default function StatefulSetsPage({ token, user }) {
  const [items, setItems] = useState([]);

  const [namespaceFilter, setNamespaceFilter] = useState(() => {
    if (typeof window === 'undefined') return 'all';
    return localStorage.getItem('sts_ns') || 'all';
  });
  const [search, setSearch] = useState('');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [reloadTick, setReloadTick] = useState(0);

  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

  const [liveState, setLiveState] = useState('connecting');

  const [actionStatus, setActionStatus] = useState('');
  const [actionError, setActionError] = useState('');

  const [scaleValue, setScaleValue] = useState('');

  const [toasts, setToasts] = useState([]);
  const pushToast = (type, message) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  };

  const isAdmin = (user?.role || '').toLowerCase() === 'admin';

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('sts_ns', namespaceFilter);
    }
  }, [namespaceFilter]);

  // Load list
  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const qs = new URLSearchParams();
        if (namespaceFilter) qs.set('namespace', namespaceFilter);
        if (search.trim()) qs.set('search', search.trim());

        const res = await fetch(`/api/statefulsets?${qs.toString()}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const text = await res.text();
        if (!res.ok) {
          let msg = text || 'Failed to load statefulsets';
          try {
            const obj = JSON.parse(text);
            msg = obj.error || msg;
          } catch {}
          throw new Error(msg);
        }

        const data = JSON.parse(text);
        const next = Array.isArray(data.items) ? data.items : [];

        if (cancelled) return;

        setItems(next);

        // keep selection if still present
        if (selected) {
          const found = next.find(
            (x) => x.namespace === selected.namespace && x.name === selected.name
          );
          if (!found) {
            setSelected(null);
            setDetail(null);
          }
        }
      } catch (err) {
        console.error('statefulsets fetch failed', err);
        const msg = err.message || 'Failed to load statefulsets';
        if (!cancelled) {
          setError(msg);
          setItems([]);
          setSelected(null);
          setDetail(null);
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
  }, [token, namespaceFilter, reloadTick]);

  // SSE stream (cluster-wide)
  useEffect(() => {
    if (!token) return;

    const es = new EventSourcePolyfill('/api/statefulsets/stream', {
      headers: { Authorization: `Bearer ${token}` },
      heartbeatTimeout: 60000,
    });

    setLiveState('connecting');

    es.onopen = () => setLiveState('open');
    es.onerror = () => setLiveState('connecting');

    es.addEventListener('upsert', (evt) => {
      try {
        const s = JSON.parse(evt.data);
        setItems((prev) => {
          const idx = prev.findIndex((x) => x.namespace === s.namespace && x.name === s.name);
          if (idx === -1) return [...prev, s];
          const copy = prev.slice();
          copy[idx] = { ...copy[idx], ...s };
          return copy;
        });
      } catch (e) {
        console.error('bad sts upsert event', e);
      }
    });

    es.addEventListener('delete', (evt) => {
      try {
        const payload = JSON.parse(evt.data);
        const ns = payload.namespace;
        const name = payload.name;
        setItems((prev) => prev.filter((x) => !(x.namespace === ns && x.name === name)));
      } catch (e) {
        console.error('bad sts delete event', e);
      }
    });

    return () => {
      setLiveState('closed');
      es.close();
    };
  }, [token]);

  const namespaces = useMemo(() => {
    const set = new Set(items.map((x) => x.namespace).filter(Boolean));
    return Array.from(set).sort();
  }, [items]);

  const filtered = useMemo(() => {
    const ns = namespaceFilter;
    const q = search.trim().toLowerCase();
    return items
      .filter((x) => {
        if (ns && ns !== 'all' && x.namespace !== ns) return false;
        if (!q) return true;
        const text = `${x.namespace}/${x.name} ${x.service || ''} ${x.status || ''} ${x.notice || ''}`.toLowerCase();
        return text.includes(q);
      })
      .sort((a, b) => {
        if (a.namespace === b.namespace) return a.name.localeCompare(b.name);
        return a.namespace.localeCompare(b.namespace);
      });
  }, [items, namespaceFilter, search]);

  const handleSelect = async (row) => {
    setSelected(row);
    setDetail(null);
    setDetailError('');
    setDetailLoading(true);
    setActionStatus('');
    setActionError('');
    setScaleValue('');

    try {
      const res = await fetch(
        `/api/statefulsets/${encodeURIComponent(row.namespace)}/${encodeURIComponent(row.name)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const text = await res.text();
      if (!res.ok) {
        let msg = text || 'Failed to load statefulset detail';
        try {
          const obj = JSON.parse(text);
          msg = obj.error || msg;
        } catch {}
        throw new Error(msg);
      }
      const data = JSON.parse(text);
      setDetail(data);
      setScaleValue(String(data.desired ?? ''));
    } catch (err) {
      console.error('sts detail fetch failed', err);
      const msg = err.message || 'Failed to load statefulset detail';
      setDetailError(msg);
      pushToast('error', msg);
    } finally {
      setDetailLoading(false);
    }
  };

  const handleScale = async () => {
    if (!isAdmin || !selected) return;
    const n = Number(scaleValue);
    if (!Number.isFinite(n) || n < 0) {
      pushToast('error', 'replicas must be a number >= 0');
      return;
    }

    setActionError('');
    setActionStatus(`Scaling ${selected.namespace}/${selected.name} to ${n}…`);
    pushToast('info', `Scaling ${selected.namespace}/${selected.name} to ${n}…`);

    try {
      const res = await fetch(
        `/api/statefulsets/${encodeURIComponent(selected.namespace)}/${encodeURIComponent(selected.name)}/scale`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ replicas: n }),
        }
      );

      const text = await res.text();
      if (!res.ok) {
        let msg = text || 'Scale failed';
        try {
          const obj = JSON.parse(text);
          msg = obj.error || msg;
        } catch {}
        throw new Error(msg);
      }

      const obj = (() => {
        try { return JSON.parse(text); } catch { return null; }
      })();

      const msg = obj?.message || `Scale requested`;
      setActionStatus(msg);
      pushToast('success', msg);

      // refresh detail quickly
      await handleSelect(selected);
    } catch (err) {
      console.error('scale sts failed', err);
      const msg = err.message || 'Scale failed';
      setActionError(msg);
      pushToast('error', msg);
    }
  };

  const handleBulkScaleFiltered = async () => {
    if (!isAdmin) return;
    if (namespaceFilter === 'all') {
      pushToast('error', 'Select a namespace first (bulk scale is namespace-scoped).');
      return;
    }
    const n = Number(scaleValue);
    if (!Number.isFinite(n) || n < 0) {
      pushToast('error', 'replicas must be a number >= 0');
      return;
    }

    const names = filtered.map((x) => x.name);

    pushToast('info', `Bulk scaling ${namespaceFilter} (${names.length} item(s)) to ${n}…`);

    try {
      const res = await fetch(
        `/api/statefulsets/namespace/${encodeURIComponent(namespaceFilter)}/scale-bulk`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ replicas: n, names }),
        }
      );
      const text = await res.text();
      if (!res.ok) {
        let msg = text || 'Bulk scale failed';
        try {
          const obj = JSON.parse(text);
          msg = obj.error || msg;
        } catch {}
        throw new Error(msg);
      }
      const obj = (() => { try { return JSON.parse(text); } catch { return null; } })();
      const msg =
        obj
          ? `Bulk scale: ok=${obj.okCount} failed=${obj.failCount}`
          : 'Bulk scale done';
      pushToast('success', msg);
      setReloadTick((r) => r + 1);
    } catch (err) {
      console.error('bulk scale failed', err);
      pushToast('error', err.message || 'Bulk scale failed');
    }
  };

  return (
    <>
      <section class="grid gap-4 lg:grid-cols-[2fr,1.3fr]">
        {/* Left: list */}
        <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div class="flex flex-wrap items-center justify-between gap-3 mb-3">
            <div>
              <h2 class="text-sm font-semibold text-slate-800">StatefulSets</h2>
              <p class="text-xs text-slate-500">
                List, filter, inspect and scale StatefulSets (live updates).
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
                  <option key={ns} value={ns}>{ns}</option>
                ))}
              </select>

              <input
                type="text"
                placeholder="Search name / service…"
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
              <span>loading statefulsets…</span>
            ) : (
              <span>{filtered.length} shown / {items.length} total</span>
            )}
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
                    <th class="text-left font-medium px-2 py-1">Desired</th>
                    <th class="text-left font-medium px-2 py-1">Ready</th>
                    <th class="text-left font-medium px-2 py-1">Updated</th>
                    <th class="text-left font-medium px-2 py-1">Service</th>
                    <th class="text-left font-medium px-2 py-1">Age</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((s) => (
                    <tr
                      key={`${s.namespace}-${s.name}`}
                      class={
                        'cursor-pointer bg-slate-50 hover:bg-slate-100 ' +
                        (selected && selected.namespace === s.namespace && selected.name === s.name
                          ? 'outline outline-1 outline-emerald-400/70'
                          : '')
                      }
                      onClick={() => handleSelect(s)}
                    >
                      <td class="px-2 py-1 align-top">
                        <div class="font-mono text-[11px] text-slate-800">{s.name}</div>
                        {s.notice && (
                          <div class="text-[11px] text-slate-500 font-mono truncate max-w-[260px]">
                            {s.notice}
                          </div>
                        )}
                      </td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-600 font-mono">{s.namespace}</td>
                      <td class="px-2 py-1 align-top text-[11px]">
                        <StatusBadge status={s.status} />
                      </td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-700 font-mono">{s.desired}</td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-700 font-mono">{s.ready}</td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-700 font-mono">{s.updated}</td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-700 font-mono">{s.service || '-'}</td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-600 font-mono">{s.age}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {filtered.length === 0 && (
                <div class="mt-3 text-xs text-slate-500">
                  No statefulsets match the current filters.
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right: details */}
        <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div class="flex items-center justify-between mb-3">
            <div>
              <h2 class="text-sm font-semibold text-slate-800">StatefulSet details</h2>
              <p class="text-xs text-slate-500">
                Spec/status, containers, selectors, volume claims, labels & annotations.
              </p>
            </div>
            {selected && (
              <div class="text-[11px] text-slate-500 font-mono text-right max-w-[55%] truncate">
                {selected.namespace}/{selected.name}
              </div>
            )}
          </div>

          {!selected && (
            <div class="text-xs text-slate-500">
              No StatefulSet selected. Click a row on the left to see details.
            </div>
          )}

          {selected && detailLoading && (
            <div class="text-xs text-slate-500 font-mono">
              loading statefulset detail…
            </div>
          )}

          {selected && detailError && !detailLoading && (
            <div class="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {detailError}
            </div>
          )}

          {selected && detail && !detailLoading && !detailError && (
            <DetailPanel
              detail={detail}
              isAdmin={isAdmin}
              scaleValue={scaleValue}
              setScaleValue={setScaleValue}
              onScale={handleScale}
              onBulkScale={handleBulkScaleFiltered}
              namespaceFilter={namespaceFilter}
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

function StatusBadge({ status }) {
  const s = (status || '').toLowerCase();
  let cls = 'bg-slate-100 text-slate-700 border-slate-200';
  if (s === 'ready') cls = 'bg-emerald-50 text-emerald-700 border-emerald-200';
  else if (s.includes('not') || s.includes('fail')) cls = 'bg-rose-50 text-rose-700 border-rose-200';
  else if (s.includes('update') || s.includes('progress')) cls = 'bg-amber-50 text-amber-700 border-amber-200';

  return (
    <span class={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-mono ${cls}`}>
      {status || 'Unknown'}
    </span>
  );
}

function DetailPanel({
  detail,
  isAdmin,
  scaleValue,
  setScaleValue,
  onScale,
  onBulkScale,
  namespaceFilter,
  actionStatus,
  actionError,
}) {
  const labels = detail.labels || {};
  const annotations = detail.annotations || {};
  const selector = detail.selector || {};
  const containers = detail.containers || [];
  const claims = detail.volumeClaims || [];

  return (
    <div class="space-y-4 text-xs">
      {/* Summary */}
      <div class="flex flex-wrap items-center gap-3">
        <StatusBadge status={detail.status} />
        <span class="font-mono text-slate-600">desired={detail.desired}</span>
        <span class="font-mono text-slate-600">ready={detail.ready}</span>
        <span class="font-mono text-slate-600">updated={detail.updated}</span>
        <span class="font-mono text-slate-600">service={detail.service || '-'}</span>
        <span class="font-mono text-slate-600">age={detail.age}</span>
      </div>

      {detail.notice && (
        <div class="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900 font-mono break-words">
          {detail.notice}
        </div>
      )}

      {/* Admin scale controls */}
      {isAdmin && (
        <div class="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 space-y-2">
          <div class="flex items-center justify-between">
            <div class="text-[11px] text-slate-600 font-mono">
              mode="admin"
            </div>
            {namespaceFilter !== 'all' && (
              <button
                type="button"
                class="rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-100"
                onClick={onBulkScale}
              >
                Bulk scale filtered in ns
              </button>
            )}
          </div>

          <div class="flex items-center gap-2">
            <input
              type="number"
              min="0"
              class="w-28 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700"
              value={scaleValue}
              onInput={(e) => setScaleValue(e.target.value)}
            />
            <button
              type="button"
              class="rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-100"
              onClick={onScale}
            >
              Scale
            </button>
          </div>

          {actionStatus && (
            <div class="text-[11px] text-emerald-700 font-mono">{actionStatus}</div>
          )}
          {actionError && (
            <div class="text-[11px] text-rose-700 font-mono">{actionError}</div>
          )}
        </div>
      )}

      {/* Selector */}
      <div>
        <h3 class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em] mb-1">
          Selector
        </h3>
        <KeyValueList obj={selector} emptyLabel="No selector labels." />
      </div>

      {/* Containers */}
      <div>
        <h3 class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em] mb-1">
          Containers
        </h3>
        {containers.length === 0 ? (
          <div class="text-[11px] text-slate-500">No containers.</div>
        ) : (
          <div class="space-y-2">
            {containers.map((c) => (
              <div key={c.name} class="rounded-lg border border-slate-200 bg-white px-3 py-2">
                <div class="flex items-center justify-between">
                  <span class="font-mono text-[11px] text-slate-800">{c.name}</span>
                </div>
                <div class="text-[11px] text-slate-500 break-all">
                  image: <span class="font-mono">{c.image}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* PVC templates */}
      <div>
        <h3 class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em] mb-1">
          VolumeClaimTemplates
        </h3>
        {claims.length === 0 ? (
          <div class="text-[11px] text-slate-500">None.</div>
        ) : (
          <div class="space-y-1 text-[11px]">
            {claims.map((n) => (
              <div key={n} class="font-mono text-slate-700">{n}</div>
            ))}
          </div>
        )}
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

      {/* Raw */}
      <div>
        <h3 class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em] mb-1">
          Raw
        </h3>
        <div class="rounded-xl border border-slate-200 bg-white p-3 max-w-full overflow-x-auto">
          <pre class="text-[11px] font-mono text-slate-700 whitespace-pre-wrap break-words">
            {JSON.stringify(detail, null, 2)}
          </pre>
        </div>
      </div>
    </div>
  );
}

function KeyValueList({ obj, emptyLabel = 'None.' }) {
  const entries = Object.entries(obj || {});
  if (entries.length === 0) {
    return <div class="text-[11px] text-slate-500">{emptyLabel}</div>;
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

import { h } from 'preact';
import { useState, useEffect, useMemo } from 'preact/hooks';
import { EventSourcePolyfill } from 'event-source-polyfill';

export default function DeploymentsPage({ token, user }) {
  const [deployments, setDeployments] = useState([]);
  const [namespaceFilter, setNamespaceFilter] = useState(() => {
    if (typeof window === 'undefined') return 'all';
    return localStorage.getItem('deployments_ns') || 'all';
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

  // Toasts (bottom-right notifications)
  const [toasts, setToasts] = useState([]);
  const pushToast = (type, message) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  };

  const isAdmin = (user?.role || '').toLowerCase() === 'admin';

  // Remember namespace
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('deployments_ns', namespaceFilter);
    }
  }, [namespaceFilter]);

  // One-off load of full list
  useEffect(() => {
    if (!token) return;

    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const res = await fetch('/api/deployments', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          const txt = await res.text();
          throw new Error(txt || 'Failed to load deployments');
        }
        const data = await res.json();
        if (!cancelled) {
          setDeployments(Array.isArray(data.items) ? data.items : []);
        }
      } catch (err) {
        console.error('deployments fetch failed', err);
        if (!cancelled) {
          const msg = err.message || 'Failed to load deployments';
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Live SSE stream (no polling, no blink)
  useEffect(() => {
    if (!token) return;

    const es = new EventSourcePolyfill('/api/deployments/stream', {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      heartbeatTimeout: 60000,
    });

    setLiveState('connecting');

    es.onopen = () => {
      setLiveState('open');
    };

    es.onerror = (err) => {
      console.warn('deployments stream error', err);
      setLiveState('connecting'); // polyfill/browser will auto-reconnect
    };

    es.addEventListener('upsert', (evt) => {
      try {
        const d = JSON.parse(evt.data);
        setDeployments((prev) => {
          const idx = prev.findIndex(
            (r) => r.namespace === d.namespace && r.name === d.name
          );
          if (idx === -1) {
            return [...prev, d];
          }
          const copy = prev.slice();
          copy[idx] = { ...copy[idx], ...d };
          return copy;
        });
      } catch (e) {
        console.error('bad upsert event', e);
      }
    });

    es.addEventListener('delete', (evt) => {
      try {
        const payload = JSON.parse(evt.data);
        const ns = payload.namespace;
        const name = payload.name;
        setDeployments((prev) =>
          prev.filter((r) => !(r.namespace === ns && r.name === name))
        );
      } catch (e) {
        console.error('bad delete event', e);
      }
    });

    return () => {
      setLiveState('closed');
      es.close();
    };
  }, [token]);

  // Derived namespaces from current list
  const namespaces = useMemo(() => {
    const set = new Set(deployments.map((d) => d.namespace));
    return Array.from(set).sort();
  }, [deployments]);

  // Filter rows by namespace + search
  const filtered = useMemo(() => {
    const ns = namespaceFilter;
    const q = search.trim().toLowerCase();
    return deployments.filter((d) => {
      if (ns && ns !== 'all' && d.namespace !== ns) return false;
      if (!q) return true;
      const text = `${d.namespace}/${d.name}`.toLowerCase();
      return text.includes(q);
    });
  }, [deployments, namespaceFilter, search]);

  // Load detail on row click
  const handleSelect = async (d) => {
    setSelected(d);
    setDetail(null);
    setDetailError('');
    setDetailLoading(true);
    setActionStatus('');
    setActionError('');
    setScaleInput('');

    try {
      const res = await fetch(
        `/api/deployments/${encodeURIComponent(d.namespace)}/${encodeURIComponent(
          d.name
        )}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt || 'Failed to load deployment detail');
      }
      const data = await res.json();
      setDetail(data);
      if (typeof data.replicas === 'number') {
        setScaleInput(String(data.replicas));
      }
    } catch (err) {
      console.error('deployment detail fetch failed', err);
      const msg = err.message || 'Failed to load deployment detail';
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
              <h2 class="text-sm font-semibold text-slate-800">Deployments</h2>
              <p class="text-xs text-slate-500">
                Real deployments with live updates, namespace filter and scaling.
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
            {loading ? (
              <span>loading deployments…</span>
            ) : (
              <span>
                {filtered.length} shown / {deployments.length} total
              </span>
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
                    <th class="text-left font-medium px-2 py-1">Replicas</th>
                    <th class="text-left font-medium px-2 py-1">Age</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((d) => (
                    <tr
                      key={`${d.namespace}-${d.name}`}
                      class={
                        'cursor-pointer bg-slate-50 hover:bg-slate-100 ' +
                        (selected &&
                        selected.namespace === d.namespace &&
                        selected.name === d.name
                          ? 'outline outline-1 outline-emerald-400/70'
                          : '')
                      }
                      onClick={() => handleSelect(d)}
                    >
                      <td class="px-2 py-1 align-top">
                        <div class="font-mono text-[11px] text-slate-800">
                          {d.name}
                        </div>
                      </td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-600 font-mono">
                        {d.namespace}
                      </td>
                      <td class="px-2 py-1 align-top text-[11px]">
                        <DeploymentStatusBadge status={d.status} />
                      </td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-700 font-mono">
                        {d.readyReplicas}/{d.replicas}
                      </td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-600 font-mono">
                        {d.age}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {filtered.length === 0 && (
                <div class="mt-3 text-xs text-slate-500">
                  No deployments match the current filters.
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right: info sidebar */}
        <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div class="flex items-center justify-between mb-3">
            <div>
              <h2 class="text-sm font-semibold text-slate-800">
                Deployment details
              </h2>
              <p class="text-xs text-slate-500">
                Summary, containers, labels, annotations (readonly).
              </p>
            </div>
            {selected && (
              <div class="text-[11px] text-slate-500 font-mono">
                {selected.namespace}/{selected.name}
              </div>
            )}
          </div>

          <div class="mb-3 text-[11px] text-slate-500 font-mono">
            ns={namespaceFilter === 'all' ? '"all"' : `"${namespaceFilter}"`}
          </div>

          {!selected && (
            <div class="text-xs text-slate-500">
              No deployment selected. Click a row on the left to see details.
            </div>
          )}

          {selected && detailLoading && (
            <div class="text-xs text-slate-500 font-mono">
              loading deployment detail…
            </div>
          )}

          {selected && detailError && !detailLoading && (
            <div class="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {detailError}
            </div>
          )}

          {selected && detail && !detailLoading && !detailError && (
            <DeploymentDetailPanel
              detail={detail}
              isAdmin={isAdmin}
              actionStatus={actionStatus}
              actionError={actionError}
            />
          )}
        </div>
      </section>

      {/* Toast container (bottom-right) */}
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

function DeploymentStatusBadge({ status }) {
  const s = (status || '').toLowerCase();
  let cls = 'bg-slate-100 text-slate-700 border-slate-200';
  if (s === 'ready') {
    cls = 'bg-emerald-50 text-emerald-700 border-emerald-200';
  } else if (s === 'notready') {
    cls = 'bg-amber-50 text-amber-700 border-amber-200';
  } else if (s === 'scaleddown') {
    cls = 'bg-slate-100 text-slate-500 border-slate-200';
  }

  return (
    <span
      class={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-mono ${cls}`}
    >
      {status}
    </span>
  );
}

function DeploymentDetailPanel({
  detail,
  isAdmin,
  actionStatus,
  actionError,
}) {
  const labels = detail.labels || {};
  const annotations = detail.annotations || {};
  const containers = detail.containers || [];

  return (
    <div class="space-y-4 text-xs">
      {/* Quick summary */}
      <div class="flex flex-wrap items-center gap-3">
        <DeploymentStatusBadge status={detail.status} />
        <span class="font-mono text-slate-600">
          replicas={detail.readyReplicas}/{detail.replicas}
        </span>
        <span class="font-mono text-slate-600">
          updated={detail.updatedReplicas}
        </span>
        <span class="font-mono text-slate-600">
          age={detail.age}
        </span>
      </div>

      {/* Status */}
      <div class="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 flex flex-col gap-2">
        {actionStatus && (
          <div class="text-[11px] text-emerald-700 font-mono">
            {actionStatus}
          </div>
        )}
        {actionError && (
          <div class="text-[11px] text-rose-700 font-mono">
            {actionError}
          </div>
        )}
      </div>

      {/* Containers */}
      <div>
        <h3 class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em] mb-1">
          Template containers
        </h3>
        <div class="space-y-2">
          {containers.map((c) => (
            <div
              key={c.name}
              class="rounded-lg border border-slate-200 bg-white px-3 py-2 flex flex-col gap-1"
            >
              <div class="flex items-center justify-between">
                <span class="font-mono text-[11px] text-slate-800">
                  {c.name}
                </span>
              </div>
              <div class="text-[11px] text-slate-500 break-all">
                image: <span class="font-mono">{c.image}</span>
              </div>
            </div>
          ))}
          {containers.length === 0 && (
            <div class="text-[11px] text-slate-500">No container templates.</div>
          )}
        </div>
      </div>

      {/* Labels & annotations */}
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
    return (
      <div class="text-[11px] text-slate-500">
        None.
      </div>
    );
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

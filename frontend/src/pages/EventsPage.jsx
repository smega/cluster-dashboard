// src/pages/EventsPage.jsx
import { h } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';

function normalizeNamespaces(data) {
  if (!data) return [];
  if (Array.isArray(data.namespaces)) return data.namespaces.filter(Boolean);

  if (Array.isArray(data.items) && data.items.length > 0) {
    if (typeof data.items[0] === 'string') return data.items.filter(Boolean);
    return data.items.map((x) => (x && typeof x === 'object' ? x.name : '')).filter(Boolean);
  }

  if (Array.isArray(data)) {
    if (typeof data[0] === 'string') return data.filter(Boolean);
    return data.map((x) => x?.name).filter(Boolean);
  }

  return [];
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function pickEventTs(e) {
  // try common k8s event timestamp fields
  return (
    e.lastTimestamp ||
    e.eventTime ||
    e.firstTimestamp ||
    e.metadata?.creationTimestamp ||
    ''
  );
}

function fmtTs(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toISOString().replace('.000Z', 'Z');
}

function buildObjectRef(e) {
  const inv = e.involvedObject || {};
  const kind = e.involvedObjectKind || inv.kind || '';
  const name = e.involvedObjectName || inv.name || '';
  const ns =
    e.involvedObjectNamespace || inv.namespace || e.namespace || e.metadata?.namespace || '';

  if (!kind && !name) return '-';
  if (ns) return `${kind}/${ns}/${name}`;
  return `${kind}/${name}`;
}

function eventKey(e, idx) {
  const ns = e.namespace || e.metadata?.namespace || '';
  const name = e.name || e.metadata?.name || '';
  const uid = e.uid || e.metadata?.uid || '';
  return uid || `${ns}/${name}` || `${idx}`;
}

export default function EventsPage({ token, user }) {
  const [events, setEvents] = useState([]);
  const [namespaces, setNamespaces] = useState([]);

  const [namespaceFilter, setNamespaceFilter] = useState(() => {
    if (typeof window === 'undefined') return 'all';
    return localStorage.getItem('events_ns') || 'all';
  });

  const [typeFilter, setTypeFilter] = useState(() => {
    if (typeof window === 'undefined') return 'all';
    return localStorage.getItem('events_type') || 'all'; // all | warning | normal
  });

  const [search, setSearch] = useState('');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [reloadTick, setReloadTick] = useState(0);

  const [selected, setSelected] = useState(null);

  const [toasts, setToasts] = useState([]);
  const pushToast = (type, message) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  };

  const isAdmin = (user?.role || '').toLowerCase() === 'admin'; // currently read-only, but handy to show mode

  // Persist filters
  useEffect(() => {
    if (typeof window !== 'undefined') localStorage.setItem('events_ns', namespaceFilter);
  }, [namespaceFilter]);

  useEffect(() => {
    if (typeof window !== 'undefined') localStorage.setItem('events_type', typeFilter);
  }, [typeFilter]);

  // Load namespaces
  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    const loadNamespaces = async () => {
      try {
        const res = await fetch('/api/kube/namespaces', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const text = await res.text();
        if (!res.ok) {
          let msg = text || 'Failed to load namespaces';
          const obj = safeJsonParse(text);
          if (obj?.error) msg = obj.error;
          throw new Error(msg);
        }

        const data = safeJsonParse(text) || {};
        const ns = normalizeNamespaces(data);

        if (cancelled) return;
        setNamespaces(Array.from(new Set(ns)).sort());
      } catch (err) {
        console.error('namespaces fetch failed', err);
        if (!cancelled) pushToast('error', err.message || 'Failed to load namespaces');
        // don't clear namespaces — fallback to derived list below
      }
    };

    loadNamespaces();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Load events
  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const nsQ = namespaceFilter && namespaceFilter !== 'all' ? namespaceFilter : 'all';
        const res = await fetch(`/api/kube/events?namespace=${encodeURIComponent(nsQ)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const text = await res.text();
        if (!res.ok) {
          let msg = text || 'Failed to load events';
          const obj = safeJsonParse(text);
          if (obj?.error) msg = obj.error;
          throw new Error(msg);
        }

        const data = safeJsonParse(text);
        if (!data) throw new Error('Invalid JSON from /api/kube/events');

        if (cancelled) return;

        const items = Array.isArray(data.items) ? data.items : [];
        setEvents(items);

        // Keep selection if still present
        if (selected) {
          const selKey = eventKey(selected, -1);
          const found = items.find((e, idx) => eventKey(e, idx) === selKey);
          if (!found) setSelected(null);
        }
      } catch (err) {
        console.error('events fetch failed', err);
        const msg = err.message || 'Failed to load events';
        if (!cancelled) {
          setError(msg);
          setEvents([]);
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
  }, [token, namespaceFilter, reloadTick]);

  // Fallback namespaces derived from events (if /kube/namespaces shape mismatches or fails)
  const namespacesFromEvents = useMemo(() => {
    const set = new Set(
      events
        .map((e) => e.namespace || e.metadata?.namespace || '')
        .filter(Boolean)
    );
    return Array.from(set).sort();
  }, [events]);

  const namespaceOptions = useMemo(() => {
    const src = (namespaces && namespaces.length > 0) ? namespaces : namespacesFromEvents;
    return Array.from(new Set(src)).sort();
  }, [namespaces, namespacesFromEvents]);

  // Filtered events (client-side type + search)
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const tf = (typeFilter || 'all').toLowerCase();

    const out = events.filter((e) => {
      const t = String(e.type || e.eventType || '').toLowerCase(); // Warning/Normal
      if (tf !== 'all') {
        if (tf === 'warning' && t !== 'warning') return false;
        if (tf === 'normal' && t !== 'normal') return false;
      }

      if (!q) return true;

      const ns = e.namespace || e.metadata?.namespace || '';
      const name = e.name || e.metadata?.name || '';
      const reason = e.reason || '';
      const msg = e.message || '';
      const objRef = buildObjectRef(e);

      const text = `${ns}/${name} ${reason} ${objRef} ${msg}`.toLowerCase();
      return text.includes(q);
    });

    // Sort by timestamp desc
    out.sort((a, b) => {
      const at = new Date(pickEventTs(a)).getTime() || 0;
      const bt = new Date(pickEventTs(b)).getTime() || 0;
      return bt - at;
    });

    return out;
  }, [events, typeFilter, search]);

  return (
    <>
      <section class="grid gap-4 lg:grid-cols-[2fr,1.3fr]">
        {/* Left: list */}
        <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div class="flex flex-wrap items-center justify-between gap-3 mb-3">
            <div>
              <h2 class="text-sm font-semibold text-slate-800">Events & Warnings</h2>
              <p class="text-xs text-slate-500">
                Kubernetes Events (cluster-wide or per-namespace). Use filters to narrow noise.
              </p>
            </div>

            <div class="flex flex-wrap items-center gap-2 text-xs">
              <select
                class="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700"
                value={namespaceFilter}
                onChange={(e) => setNamespaceFilter(e.target.value)}
              >
                <option value="all">All namespaces</option>
                {namespaceOptions.map((ns) => (
                  <option key={ns} value={ns}>
                    {ns}
                  </option>
                ))}
              </select>

              <select
                class="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700"
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
              >
                <option value="all">All types</option>
                <option value="warning">Warning</option>
                <option value="normal">Normal</option>
              </select>

              <input
                type="text"
                placeholder="Search reason / object / message…"
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
              <span>loading events…</span>
            ) : (
              <span>
                {filtered.length} shown / {events.length} loaded
              </span>
            )}
            <span>mode={isAdmin ? '"admin"' : '"readonly"'}</span>
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
                    <th class="text-left font-medium px-2 py-1">Type</th>
                    <th class="text-left font-medium px-2 py-1">Reason</th>
                    <th class="text-left font-medium px-2 py-1">Namespace</th>
                    <th class="text-left font-medium px-2 py-1">Object</th>
                    <th class="text-left font-medium px-2 py-1">Message</th>
                    <th class="text-left font-medium px-2 py-1">Count</th>
                    <th class="text-left font-medium px-2 py-1">Last</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((e, idx) => {
                    const ns = e.namespace || e.metadata?.namespace || '-';
                    const reason = e.reason || '-';
                    const msg = e.message || '-';
                    const typ = e.type || e.eventType || '-';
                    const cnt = e.count ?? e.series?.count ?? '-';
                    const last = e.lastSeen || e.lastTimestamp || e.eventTime || pickEventTs(e);
                    const key = eventKey(e, idx);

                    const isSel =
                      selected && eventKey(selected, -1) === key;

                    return (
                      <tr
                        key={key}
                        class={
                          'cursor-pointer bg-slate-50 hover:bg-slate-100 ' +
                          (isSel ? 'outline outline-1 outline-emerald-400/70' : '')
                        }
                        onClick={() => setSelected(e)}
                      >
                        <td class="px-2 py-1 align-top text-[11px]">
                          <EventTypeBadge type={typ} />
                        </td>
                        <td class="px-2 py-1 align-top text-[11px] text-slate-700 font-mono">
                          {reason}
                        </td>
                        <td class="px-2 py-1 align-top text-[11px] text-slate-600 font-mono">
                          {ns}
                        </td>
                        <td class="px-2 py-1 align-top text-[11px] text-slate-700 font-mono">
                          {buildObjectRef(e)}
                        </td>
                        <td class="px-2 py-1 align-top text-[11px] text-slate-700">
                          <div class="max-w-[520px] truncate">{msg}</div>
                        </td>
                        <td class="px-2 py-1 align-top text-[11px] text-slate-700 font-mono">
                          {String(cnt)}
                        </td>
                        <td class="px-2 py-1 align-top text-[11px] text-slate-600 font-mono">
                          {e.age ? e.age : fmtTs(last)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {filtered.length === 0 && (
                <div class="mt-3 text-xs text-slate-500">
                  No events match the current filters.
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right: details */}
        <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div class="flex items-center justify-between mb-3">
            <div>
              <h2 class="text-sm font-semibold text-slate-800">Event details</h2>
              <p class="text-xs text-slate-500">
                Full message, involved object, timestamps, and raw JSON.
              </p>
            </div>
            {selected && (
              <div class="text-[11px] text-slate-500 font-mono text-right max-w-[55%] truncate">
                {(selected.namespace || selected.metadata?.namespace || '-')}/
                {(selected.name || selected.metadata?.name || '-')}
              </div>
            )}
          </div>

          {!selected && (
            <div class="text-xs text-slate-500">
              No event selected. Click a row on the left to see details.
            </div>
          )}

          {selected && <EventDetailPanel ev={selected} />}
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

function EventTypeBadge({ type }) {
  const t = String(type || '').toLowerCase();
  let cls = 'bg-slate-100 text-slate-700 border-slate-200';
  let label = type || 'Unknown';

  if (t === 'warning') cls = 'bg-rose-50 text-rose-700 border-rose-200';
  else if (t === 'normal') cls = 'bg-emerald-50 text-emerald-700 border-emerald-200';

  return (
    <span class={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-mono ${cls}`}>
      {label}
    </span>
  );
}

function EventDetailPanel({ ev }) {
  const ns = ev.namespace || ev.metadata?.namespace || '-';
  const name = ev.name || ev.metadata?.name || '-';
  const typ = ev.type || ev.eventType || '-';
  const reason = ev.reason || '-';
  const msg = ev.message || '-';

  const objRef = buildObjectRef(ev);

  const first = ev.firstTimestamp || ev.metadata?.creationTimestamp || '';
  const last = ev.lastTimestamp || ev.eventTime || pickEventTs(ev) || '';
  const age = ev.age || '-';
  const count = ev.count ?? ev.series?.count ?? '-';

  const reportingComponent =
    ev.reportingComponent || ev.source?.component || ev.sourceComponent || '';
  const reportingInstance =
    ev.reportingInstance || ev.source?.host || ev.sourceHost || '';

  return (
    <div class="space-y-4 text-xs">
      {/* Summary */}
      <div class="flex flex-wrap items-center gap-3">
        <EventTypeBadge type={typ} />
        <span class="font-mono text-slate-600">ns={ns}</span>
        <span class="font-mono text-slate-600">reason={reason}</span>
        <span class="font-mono text-slate-600">count={String(count)}</span>
        <span class="font-mono text-slate-600">age={age}</span>
      </div>

      {/* Message */}
      <div class="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
        <div class="text-[11px] text-slate-600 font-mono mb-1">
          {ns}/{name}
        </div>
        <div class="text-[11px] text-slate-800 break-words">{msg}</div>
      </div>

      {/* Object + timestamps */}
      <div class="grid gap-4 md:grid-cols-2">
        <div>
          <h3 class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em] mb-1">
            Involved object
          </h3>
          <div class="text-[11px] text-slate-600">
            <span class="font-mono break-words">{objRef}</span>
          </div>

          {(ev.action || reportingComponent || reportingInstance) && (
            <div class="mt-2 space-y-1 text-[11px] text-slate-600">
              {ev.action && (
                <div>
                  action: <span class="font-mono">{ev.action}</span>
                </div>
              )}
              {reportingComponent && (
                <div>
                  component: <span class="font-mono">{reportingComponent}</span>
                </div>
              )}
              {reportingInstance && (
                <div>
                  instance: <span class="font-mono">{reportingInstance}</span>
                </div>
              )}
            </div>
          )}
        </div>

        <div>
          <h3 class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em] mb-1">
            Timestamps
          </h3>
          <div class="space-y-1 text-[11px] text-slate-600">
            <div>
              first: <span class="font-mono">{fmtTs(first)}</span>
            </div>
            <div>
              last: <span class="font-mono">{fmtTs(last)}</span>
            </div>
            {ev.metadata?.resourceVersion && (
              <div>
                rv: <span class="font-mono">{ev.metadata.resourceVersion}</span>
              </div>
            )}
            {ev.metadata?.uid && (
              <div>
                uid: <span class="font-mono break-all">{ev.metadata.uid}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Labels & annotations (if backend returns them) */}
      <div class="grid gap-4 md:grid-cols-2">
        <div>
          <h3 class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em] mb-1">
            Labels
          </h3>
          <KeyValueList obj={ev.labels || ev.metadata?.labels || {}} emptyLabel="No labels." />
        </div>
        <div>
          <h3 class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em] mb-1">
            Annotations
          </h3>
          <KeyValueList
            obj={ev.annotations || ev.metadata?.annotations || {}}
            emptyLabel="No annotations."
          />
        </div>
      </div>

      {/* Raw JSON */}
      <div>
        <h3 class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em] mb-1">
          Raw
        </h3>
        <div class="rounded-xl border border-slate-200 bg-white p-3 max-w-full overflow-x-auto">
          <pre class="text-[11px] font-mono text-slate-700 whitespace-pre-wrap break-words">
            {JSON.stringify(ev, null, 2)}
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

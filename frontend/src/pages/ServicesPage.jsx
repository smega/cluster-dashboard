import { h } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';

export default function ServicesPage({ token, user }) {
  const [services, setServices] = useState([]);

  const [namespaceFilter, setNamespaceFilter] = useState(() => {
    if (typeof window === 'undefined') return 'all';
    return localStorage.getItem('services_ns') || 'all';
  });
  const [search, setSearch] = useState('');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadTick, setReloadTick] = useState(0);

  const [selected, setSelected] = useState(null);
  const [toasts, setToasts] = useState([]);

  const isAdmin = (user?.role || '').toLowerCase() === 'admin';

  const pushToast = (type, message) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  };

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('services_ns', namespaceFilter);
    }
  }, [namespaceFilter]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const res = await fetch('/api/services', {
          headers: { Authorization: `Bearer ${token}` }
        });
        const text = await res.text();
        if (!res.ok) {
          let msg = text || 'Failed to load services';
          try { msg = JSON.parse(text).error || msg; } catch {}
          throw new Error(msg);
        }

        const data = JSON.parse(text);
        const items = Array.isArray(data.items) ? data.items : [];
        if (cancelled) return;

        setServices(items);

        if (selected) {
          const found = items.find(
            (s) => s.name === selected.name && s.namespace === selected.namespace
          );
          if (!found) setSelected(null);
        }
      } catch (err) {
        const msg = err.message || 'Failed to load services';
        if (!cancelled) {
          setError(msg);
          setServices([]);
          setSelected(null);
          pushToast('error', msg);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, reloadTick]);

  useEffect(() => {
    if (!selected) return;
    if (namespaceFilter !== 'all' && selected.namespace !== namespaceFilter) {
      setSelected(null);
    }
  }, [namespaceFilter, selected]);

  const namespaces = useMemo(() => {
    const set = new Set(services.map((s) => s.namespace));
    return Array.from(set).sort();
  }, [services]);

  const filtered = useMemo(() => {
    const ns = namespaceFilter;
    const q = search.trim().toLowerCase();

    return services.filter((s) => {
      if (ns !== 'all' && s.namespace !== ns) return false;
      if (!q) return true;

      const ports = Array.isArray(s.ports)
        ? s.ports.map((p) => `${p.port}/${p.protocol || ''}`).join(' ')
        : '';
      const sel = s.selector ? Object.entries(s.selector).map(([k, v]) => `${k}=${v}`).join(' ') : '';

      return `${s.namespace}/${s.name} ${s.type || ''} ${s.clusterIP || ''} ${ports} ${sel}`
        .toLowerCase()
        .includes(q);
    });
  }, [services, namespaceFilter, search]);

  return (
    <>
      <section class="grid gap-4 lg:grid-cols-[2fr,1.3fr] min-w-0">
        {/* Left */}
        <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm min-w-0">
          <div class="flex flex-wrap items-center justify-between gap-3 mb-3">
            <div class="min-w-0">
              <h2 class="text-sm font-semibold text-slate-800">Services</h2>
              <p class="text-xs text-slate-500">
                Services with selector ↔ pod validation (like Ingress backend checks).
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
                placeholder="Search name / selector / ports…"
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
              <span>loading services…</span>
            ) : (
              <span>{filtered.length} shown / {services.length} total</span>
            )}
            <span class="text-slate-400">mode={isAdmin ? '"admin"' : '"readonly"'}</span>
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
                    <th class="text-left font-medium px-2 py-1">Type</th>
                    <th class="text-left font-medium px-2 py-1">ClusterIP</th>
                    <th class="text-left font-medium px-2 py-1">Ports</th>
                    <th class="text-left font-medium px-2 py-1">Selector</th>
                    <th class="text-left font-medium px-2 py-1">Pods</th>
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
                      onClick={() => setSelected(s)}
                    >
                      <td class="px-2 py-1 align-top">
                        <div class="font-mono text-[11px] text-slate-800">{s.name}</div>
                      </td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-600 font-mono">
                        {s.namespace}
                      </td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-700 font-mono">
                        {s.type || '-'}
                      </td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-700 font-mono">
                        {s.clusterIP || '-'}
                      </td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-700 font-mono">
                        {Array.isArray(s.ports) && s.ports.length > 0
                          ? s.ports.map((p) => `${p.port}/${(p.protocol || '').toLowerCase()}`).join(' ')
                          : '-'}
                      </td>
                      <td class="px-2 py-1 align-top text-[11px]">
                        <SelectorBadge svc={s} />
                      </td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-700 font-mono">
                        {s.hasSelector
                          ? `${s.readyPods || 0}/${s.matchingPods || 0}`
                          : '-'}
                      </td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-600 font-mono">
                        {s.age}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {filtered.length === 0 && (
                <div class="mt-3 text-xs text-slate-500">
                  No services match the current filters.
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right */}
        <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm min-w-0">
          <div class="flex items-center justify-between mb-3 gap-2 min-w-0">
            <div class="min-w-0">
              <h2 class="text-sm font-semibold text-slate-800">Service details</h2>
              <p class="text-xs text-slate-500">
                Ports, selectors, matching pods, labels and annotations.
              </p>
            </div>
            {selected && (
              <div class="text-[11px] text-slate-500 font-mono text-right truncate max-w-[14rem]">
                {selected.namespace}/{selected.name}
              </div>
            )}
          </div>

          {!selected && (
            <div class="text-xs text-slate-500">
              No service selected. Click a row on the left to see details.
            </div>
          )}

          {selected && <ServiceDetailPanel svc={selected} />}
        </div>
      </section>

      {/* Toasts */}
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

function SelectorBadge({ svc }) {
  const has = !!svc.hasSelector;
  const checked = !!svc.selectorChecked;

  // no selector is fine (ExternalName / manual endpoints / etc.)
  if (!has) {
    return (
      <span class="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-mono bg-slate-50 text-slate-700 border-slate-200">
        no selector
      </span>
    );
  }

  if (!checked) {
    return (
      <span class="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-mono bg-amber-50 text-amber-700 border-amber-200">
        unknown
      </span>
    );
  }

  if (svc.selectorOK) {
    return (
      <span class="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-mono bg-emerald-50 text-emerald-700 border-emerald-200">
        ok
      </span>
    );
  }

  return (
    <span class="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-mono bg-rose-50 text-rose-700 border-rose-200">
      mismatch
    </span>
  );
}

function ServiceDetailPanel({ svc }) {
  const ports = Array.isArray(svc.ports) ? svc.ports : [];
  const selector = svc.selector || {};
  const labels = svc.labels || {};
  const annotations = svc.annotations || {};
  const podNames = Array.isArray(svc.podNames) ? svc.podNames : [];

  return (
    <div class="space-y-4 text-xs min-w-0">
      {/* Summary */}
      <div class="flex flex-wrap items-center gap-3">
        <SelectorBadge svc={svc} />
        <span class="font-mono text-slate-600">type={svc.type || '-'}</span>
        <span class="font-mono text-slate-600">ip={svc.clusterIP || '-'}</span>
        <span class="font-mono text-slate-600">age={svc.age}</span>
        {svc.externalName && (
          <span class="font-mono text-slate-600 break-all">externalName={svc.externalName}</span>
        )}
      </div>

      {/* Ports */}
      <div>
        <h3 class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em] mb-1">
          Ports
        </h3>
        {ports.length === 0 ? (
          <div class="text-[11px] text-slate-500">No ports.</div>
        ) : (
          <div class="space-y-1">
            {ports.map((p) => (
              <div key={`${p.name}-${p.port}-${p.protocol}`} class="text-[11px] font-mono text-slate-700 break-all">
                {p.name ? `${p.name} ` : ''}
                {p.port}/{(p.protocol || '').toLowerCase()} → {p.targetPort || '-'}
                {p.nodePort ? ` nodePort=${p.nodePort}` : ''}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Selector + pods */}
      <div class="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
        <div class="flex items-center justify-between">
          <div class="text-[11px] text-slate-600 font-mono">
            selector={svc.hasSelector ? 'yes' : 'no'}
          </div>
          {svc.hasSelector && (
            <div class="text-[11px] text-slate-600 font-mono">
              ready/matching={svc.readyPods || 0}/{svc.matchingPods || 0}
            </div>
          )}
        </div>

        {svc.hasSelector && !svc.selectorChecked && svc.selectorError && (
          <div class="mt-2 text-[11px] text-amber-700 font-mono break-all">
            selectorCheckError={svc.selectorError}
          </div>
        )}

        <div class="mt-2">
          <h3 class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em] mb-1">
            Selector
          </h3>
          <KeyValueList obj={selector} emptyLabel="No selector." />
        </div>

        {svc.hasSelector && (
          <div class="mt-3">
            <h3 class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em] mb-1">
              Matching pods (sample)
            </h3>
            {podNames.length === 0 ? (
              <div class="text-[11px] text-slate-500">
                No matching pods.
              </div>
            ) : (
              <div class="space-y-1">
                {podNames.map((p) => (
                  <div key={p} class="text-[11px] font-mono text-slate-800 break-all">
                    {p}
                  </div>
                ))}
                {svc.matchingPods > podNames.length && (
                  <div class="text-[11px] text-slate-500">
                    (+{svc.matchingPods - podNames.length} more)
                  </div>
                )}
              </div>
            )}
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
    </div>
  );
}

function KeyValueList({ obj, emptyLabel = 'None.' }) {
  const entries = Object.entries(obj || {});
  if (entries.length === 0) {
    return <div class="text-[11px] text-slate-500">{emptyLabel}</div>;
  }
  return (
    <div class="space-y-1 text-[11px] min-w-0">
      {entries.map(([k, v]) => (
        <div key={k} class="flex gap-1 min-w-0">
          <span class="font-mono text-slate-500 break-all">{k}=</span>
          <span class="font-mono text-slate-800 break-all min-w-0">{String(v)}</span>
        </div>
      ))}
    </div>
  );
}

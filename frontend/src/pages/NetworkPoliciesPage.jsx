// src/pages/NetworkPoliciesPage.jsx
import { h } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';

export default function NetworkPoliciesPage({ token, user }) {
  const [items, setItems] = useState([]);
  const [namespaces, setNamespaces] = useState([]);
  const [zeroNamespaces, setZeroNamespaces] = useState([]);

  const [namespaceFilter, setNamespaceFilter] = useState(() => {
    if (typeof window === 'undefined') return 'all';
    return localStorage.getItem('netpol_ns') || 'all';
  });
  const [search, setSearch] = useState('');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadTick, setReloadTick] = useState(0);

  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

  const [toasts, setToasts] = useState([]);

  const isAdmin = (user?.role || '').toLowerCase() === 'admin';

  const pushToast = (type, message) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  };

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('netpol_ns', namespaceFilter);
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
        const url = `/api/kube/networkpolicies?namespace=${encodeURIComponent(
          namespaceFilter || 'all'
        )}`;
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const text = await res.text();
        if (!res.ok) {
          let msg = text || 'Failed to load NetworkPolicies';
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
          throw new Error('Invalid JSON from /api/kube/networkpolicies');
        }

        if (cancelled) return;

        const list = Array.isArray(data.items) ? data.items : [];
        setItems(list);

        const nss = Array.isArray(data.namespaces) ? data.namespaces : [];
        setNamespaces(nss);

        const zeros = Array.isArray(data.zeroNamespaces)
          ? data.zeroNamespaces
          : [];
        setZeroNamespaces(zeros);

        if (selected) {
          const found = list.find(
            (x) => x.namespace === selected.namespace && x.name === selected.name
          );
          if (!found) {
            setSelected(null);
            setDetail(null);
          }
        }
      } catch (err) {
        console.error('netpol fetch failed', err);
        const msg = err.message || 'Failed to load NetworkPolicies';
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

  // Filter by search
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((p) => {
      const text = `${p.namespace}/${p.name} ${p.podSelector || ''} ${(
        p.types || []
      ).join(',')}`.toLowerCase();
      return text.includes(q);
    });
  }, [items, search]);

  const handleSelect = async (p) => {
    setSelected(p);
    setDetail(null);
    setDetailError('');
    setDetailLoading(true);

    try {
      const res = await fetch(
        `/api/kube/networkpolicies/${encodeURIComponent(
          p.namespace
        )}/${encodeURIComponent(p.name)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const text = await res.text();
      if (!res.ok) {
        let msg = text || 'Failed to load NetworkPolicy detail';
        try {
          const obj = JSON.parse(text);
          msg = obj.error || msg;
        } catch {}
        throw new Error(msg);
      }
      const data = JSON.parse(text);
      setDetail(data);
    } catch (err) {
      console.error('netpol detail fetch failed', err);
      const msg = err.message || 'Failed to load NetworkPolicy detail';
      setDetailError(msg);
      pushToast('error', msg);
    } finally {
      setDetailLoading(false);
    }
  };

  const zerosPreview = useMemo(() => {
    const max = 10;
    const arr = zeroNamespaces || [];
    if (arr.length <= max) return { head: arr, rest: 0 };
    return { head: arr.slice(0, max), rest: arr.length - max };
  }, [zeroNamespaces]);

  return (
    <>
      {/* min-w-0 on grid children is the key fix for right-panel overflow */}
      <section class="grid gap-4 lg:grid-cols-[2fr,1.3fr]">
        {/* Left */}
        <div class="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div class="flex flex-wrap items-center justify-between gap-3 mb-3">
            <div>
              <h2 class="text-sm font-semibold text-slate-800">
                NetworkPolicies
              </h2>
              <p class="text-xs text-slate-500">
                Inventory + default-deny signals + namespaces with zero policies.
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
                placeholder="Search name / selector…"
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

          {/* Zero netpol warning */}
          {namespaceFilter === 'all' && zerosPreview.head.length > 0 && (
            <div class="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <div class="font-semibold mb-1">
                Security signal: namespaces with zero NetworkPolicies
              </div>
              <div class="flex flex-wrap gap-2">
                {zerosPreview.head.map((ns) => (
                  <button
                    key={ns}
                    type="button"
                    class="rounded-full border border-amber-300 bg-white px-3 py-1 text-[11px] font-mono text-amber-900 hover:bg-amber-100"
                    onClick={() => setNamespaceFilter(ns)}
                    title="Click to filter"
                  >
                    {ns}
                  </button>
                ))}
                {zerosPreview.rest > 0 && (
                  <span class="text-[11px] text-amber-800 font-mono">
                    +{zerosPreview.rest} more…
                  </span>
                )}
              </div>
            </div>
          )}

          <div class="flex items-center justify-between mb-2 text-[11px] text-slate-500 font-mono">
            {loading ? (
              <span>loading networkpolicies…</span>
            ) : (
              <span>
                {filtered.length} shown / {items.length} total
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
                    <th class="text-left font-medium px-2 py-1">Name</th>
                    <th class="text-left font-medium px-2 py-1">Namespace</th>
                    <th class="text-left font-medium px-2 py-1">Selector</th>
                    <th class="text-left font-medium px-2 py-1">Types</th>
                    <th class="text-left font-medium px-2 py-1">Ingress</th>
                    <th class="text-left font-medium px-2 py-1">Egress</th>
                    <th class="text-left font-medium px-2 py-1">
                      Default-deny
                    </th>
                    <th class="text-left font-medium px-2 py-1">Age</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((p) => (
                    <tr
                      key={`${p.namespace}-${p.name}`}
                      class={
                        'cursor-pointer bg-slate-50 hover:bg-slate-100 ' +
                        (selected &&
                        selected.namespace === p.namespace &&
                        selected.name === p.name
                          ? 'outline outline-1 outline-emerald-400/70'
                          : '')
                      }
                      onClick={() => handleSelect(p)}
                    >
                      <td class="px-2 py-1 align-top">
                        <div class="font-mono text-[11px] text-slate-800">
                          {p.name}
                        </div>
                      </td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-600 font-mono">
                        {p.namespace}
                      </td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-700 font-mono break-all">
                        {p.podSelector || '-'}
                      </td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-700 font-mono">
                        {Array.isArray(p.types) ? p.types.join(',') : '-'}
                      </td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-700 font-mono">
                        {p.ingressRules}
                      </td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-700 font-mono">
                        {p.egressRules}
                      </td>
                      <td class="px-2 py-1 align-top text-[11px]">
                        <DefaultDenyBadge
                          ingress={p.defaultDenyIngress}
                          egress={p.defaultDenyEgress}
                        />
                      </td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-600 font-mono">
                        {p.age}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {filtered.length === 0 && (
                <div class="mt-3 text-xs text-slate-500">
                  No NetworkPolicies match the current filters.
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right */}
        <div class="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm overflow-hidden">
          <div class="flex items-center justify-between mb-3">
            <div>
              <h2 class="text-sm font-semibold text-slate-800">
                Policy details
              </h2>
              <p class="text-xs text-slate-500">
                Selector, types, default-deny signal, and raw spec.
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
              No policy selected. Click a row on the left to see details.
            </div>
          )}

          {selected && detailLoading && (
            <div class="text-xs text-slate-500 font-mono">
              loading policy detail…
            </div>
          )}

          {selected && detailError && !detailLoading && (
            <div class="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {detailError}
            </div>
          )}

          {selected && detail && !detailLoading && !detailError && (
            <NetpolDetailPanel detail={detail} />
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

function DefaultDenyBadge({ ingress, egress }) {
  const parts = [];
  if (ingress) parts.push('ingress');
  if (egress) parts.push('egress');

  if (parts.length === 0) {
    return (
      <span class="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-mono bg-slate-100 text-slate-700 border-slate-200">
        none
      </span>
    );
  }

  return (
    <span class="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-mono bg-amber-50 text-amber-800 border-amber-200">
      {parts.join('+')}
    </span>
  );
}

function NetpolDetailPanel({ detail }) {
  const labels = detail.labels || {};
  const annotations = detail.annotations || {};
  const spec = detail.spec || {};

  const pretty = useMemo(() => {
    try {
      return JSON.stringify(spec, null, 2);
    } catch {
      return String(spec);
    }
  }, [spec]);

  return (
    <div class="space-y-4 text-xs min-w-0">
      {/* Summary */}
      <div class="flex flex-wrap items-center gap-3 min-w-0">
        <span class="font-mono text-slate-600 break-all">
          selector={detail.podSelector || '-'}
        </span>
        <span class="font-mono text-slate-600">
          types={(detail.types || []).join(',') || '-'}
        </span>
        <span class="font-mono text-slate-600">
          ingressRules={detail.ingressRules}
        </span>
        <span class="font-mono text-slate-600">
          egressRules={detail.egressRules}
        </span>
        <DefaultDenyBadge
          ingress={detail.defaultDenyIngress}
          egress={detail.defaultDenyEgress}
        />
        <span class="font-mono text-slate-600">age={detail.age}</span>
      </div>

      {/* Raw spec */}
      <div class="min-w-0">
        <h3 class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em] mb-1">
          Spec (raw)
        </h3>

        {/* This wrapper MUST be min-w-0 + overflow-x-auto so it scrolls internally instead of pushing the page */}
        <div class="min-w-0 max-w-full rounded-xl border border-slate-200 bg-slate-50 p-3 overflow-x-auto">
          <pre class="min-w-0 text-[11px] font-mono text-slate-800 whitespace-pre">{pretty}</pre>
        </div>
      </div>

      {/* Labels & annotations */}
      <div class="grid gap-4 md:grid-cols-2 min-w-0">
        <div class="min-w-0">
          <h3 class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em] mb-1">
            Labels
          </h3>
          <KeyValueList obj={labels} emptyLabel="No labels." />
        </div>
        <div class="min-w-0">
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
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  return (
    <div class="space-y-1 text-[11px] min-w-0">
      {entries.map(([k, v]) => (
        <div key={k} class="flex gap-1 min-w-0">
          <span class="font-mono text-slate-500">{k}=</span>
          <span class="font-mono text-slate-800 break-all">{String(v)}</span>
        </div>
      ))}
    </div>
  );
}

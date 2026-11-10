// src/pages/AutoscalingPage.jsx
import { h } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';

export default function AutoscalingPage({ token, user }) {
  const [namespaces, setNamespaces] = useState([]);

  const [namespaceFilter, setNamespaceFilter] = useState(() => {
    if (typeof window === 'undefined') return 'all';
    return localStorage.getItem('autoscale_ns') || 'all';
  });

  const [kindFilter, setKindFilter] = useState(() => {
    if (typeof window === 'undefined') return 'all';
    return localStorage.getItem('autoscale_kind') || 'all'; // all | hpa | vpa | pdb
  });

  const [search, setSearch] = useState('');

  const [hpas, setHpas] = useState([]);
  const [vpas, setVpas] = useState([]);
  const [pdbs, setPdbs] = useState([]);

  const [vpaWarning, setVpaWarning] = useState('');

  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');
  const [reloadTick, setReloadTick] = useState(0);

  const [selected, setSelected] = useState(null); // { kind, namespace, name }
  const [detail, setDetail] = useState(null);

  const [toasts, setToasts] = useState([]);

  const isAdmin = (user?.role || '').toLowerCase() === 'admin';

  const pushToast = (type, message) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  };

  // Persist filters
  useEffect(() => {
    if (typeof window !== 'undefined') localStorage.setItem('autoscale_ns', namespaceFilter);
  }, [namespaceFilter]);

  useEffect(() => {
    if (typeof window !== 'undefined') localStorage.setItem('autoscale_kind', kindFilter);
  }, [kindFilter]);

  // If user is not viewing VPA, clear warning banner
  useEffect(() => {
    if (kindFilter !== 'all' && kindFilter !== 'vpa') setVpaWarning('');
  }, [kindFilter]);

  // Load namespaces
  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch('/api/kube/namespaces', {
          headers: { Authorization: `Bearer ${token}` }
        });
        const text = await res.text();
        if (!res.ok) {
          let msg = text || 'Failed to load namespaces';
          try {
            msg = JSON.parse(text).error || msg;
          } catch {}
          throw new Error(msg);
        }
        const data = JSON.parse(text);

        const ns = (Array.isArray(data.items) ? data.items : [])
          .map((x) => x?.name)
          .filter(Boolean)
          .sort();

        if (!cancelled) setNamespaces(ns);
      } catch (err) {
        if (!cancelled) pushToast('error', err.message || 'Failed to load namespaces');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token]);

  // Load lists
  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError('');

      const ns = namespaceFilter || 'all';
      const qs = `?namespace=${encodeURIComponent(ns)}`;

      const wantHPA = kindFilter === 'all' || kindFilter === 'hpa';
      const wantVPA = kindFilter === 'all' || kindFilter === 'vpa';
      const wantPDB = kindFilter === 'all' || kindFilter === 'pdb';

      const reqs = [];
      if (wantHPA) reqs.push(['hpa', fetch(`/api/kube/hpas${qs}`, { headers: { Authorization: `Bearer ${token}` } })]);
      if (wantVPA) reqs.push(['vpa', fetch(`/api/kube/vpas${qs}`, { headers: { Authorization: `Bearer ${token}` } })]);
      if (wantPDB) reqs.push(['pdb', fetch(`/api/kube/pdbs${qs}`, { headers: { Authorization: `Bearer ${token}` } })]);

      try {
        const settled = await Promise.allSettled(reqs.map(([, p]) => p));

        let newHpas = [];
        let newVpas = [];
        let newPdbs = [];

        // keep old warning unless VPA was requested
        let newVpaWarning = wantVPA ? '' : vpaWarning;

        for (let i = 0; i < settled.length; i++) {
          const [kind] = reqs[i];
          const r = settled[i];

          if (r.status !== 'fulfilled') {
            // treat VPA failures quietly (we’ll show banner if backend returns warning)
            if (kind !== 'vpa') pushToast('error', `${kind.toUpperCase()} load failed`);
            continue;
          }

          const res = r.value;
          const text = await res.text();

          if (!res.ok) {
            let msg = text || `${kind.toUpperCase()} load failed`;
            try {
              msg = JSON.parse(text).error || msg;
            } catch {}

            // For VPA, don’t toast; it may simply not exist / be forbidden.
            if (kind !== 'vpa') pushToast('error', msg);
            continue;
          }

          let data;
          try {
            data = JSON.parse(text);
          } catch {
            data = {};
          }

          const items = Array.isArray(data.items) ? data.items : [];

          if (kind === 'hpa') newHpas = items;
          if (kind === 'pdb') newPdbs = items;

          if (kind === 'vpa') {
            newVpas = items;
            newVpaWarning = data.warning || '';
          }
        }

        if (cancelled) return;

        setHpas(newHpas);
        setVpas(newVpas);
        setPdbs(newPdbs);
        if (wantVPA) setVpaWarning(newVpaWarning);

        // keep selection if it still exists
        if (selected) {
          const exists =
            (selected.kind === 'HPA' &&
              newHpas.some((x) => x.name === selected.name && x.namespace === selected.namespace)) ||
            (selected.kind === 'VPA' &&
              newVpas.some((x) => x.name === selected.name && x.namespace === selected.namespace)) ||
            (selected.kind === 'PDB' &&
              newPdbs.some((x) => x.name === selected.name && x.namespace === selected.namespace));

          if (!exists) {
            setSelected(null);
            setDetail(null);
          }
        }
      } catch (err) {
        const msg = err.message || 'Failed to load autoscaling resources';
        if (!cancelled) {
          setError(msg);
          setHpas([]);
          setVpas([]);
          setPdbs([]);
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
  }, [token, namespaceFilter, kindFilter, reloadTick]);

  // Load detail
  useEffect(() => {
    if (!token) return;
    if (!selected) return;

    let cancelled = false;

    (async () => {
      setDetailLoading(true);
      setError('');
      setDetail(null);

      try {
        const { kind, namespace, name } = selected;

        let path = '';
        if (kind === 'HPA') path = `/api/kube/hpas/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;
        if (kind === 'VPA') path = `/api/kube/vpas/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;
        if (kind === 'PDB') path = `/api/kube/pdbs/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;

        const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
        const text = await res.text();
        if (!res.ok) {
          let msg = text || 'Failed to load details';
          try {
            msg = JSON.parse(text).error || msg;
          } catch {}
          throw new Error(msg);
        }

        const data = JSON.parse(text);
        if (!cancelled) setDetail(data);
      } catch (err) {
        const msg = err.message || 'Failed to load details';
        if (!cancelled) {
          setError(msg);
          pushToast('error', msg);
        }
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token, selected]);

  const rows = useMemo(() => {
    const a = (Array.isArray(hpas) ? hpas : []).map((x) => ({
      kind: 'HPA',
      name: x.name,
      namespace: x.namespace,
      age: x.age || '-',
      line1: `target=${x.targetKind || '-'}:${x.targetName || '-'}`,
      line2: `replicas ${x.currentReplicas}→${x.desiredReplicas} | min=${x.minReplicas ?? '-'} max=${x.maxReplicas}`,
      line3: Array.isArray(x.metrics) && x.metrics.length ? `metrics: ${x.metrics.join(', ')}` : ''
    }));

    const b = (Array.isArray(vpas) ? vpas : []).map((x) => ({
      kind: 'VPA',
      name: x.name,
      namespace: x.namespace,
      age: x.age || '-',
      line1: `target=${x.targetKind || '-'}:${x.targetName || '-'}`,
      line2: `mode=${x.updateMode || '-'} | recs=${x.recommendations ?? x.recs ?? x.Recs ?? 0}`,
      line3: x.apiVersion ? `api=${x.apiVersion}` : ''
    }));

    const c = (Array.isArray(pdbs) ? pdbs : []).map((x) => ({
      kind: 'PDB',
      name: x.name,
      namespace: x.namespace,
      age: x.age || '-',
      line1: `allowed=${x.disruptionsAllowed} | healthy=${x.currentHealthy}/${x.desiredHealthy}`,
      line2: `${x.minAvailable ? `minAvail=${x.minAvailable}` : ''}${x.maxUnavailable ? `${x.minAvailable ? ' | ' : ''}maxUnavail=${x.maxUnavailable}` : ''}`.trim(),
      line3: `expectedPods=${x.expectedPods}`
    }));

    return [...a, ...b, ...c].sort((r1, r2) => {
      if (r1.namespace === r2.namespace) {
        if (r1.kind === r2.kind) return r1.name.localeCompare(r2.name);
        return r1.kind.localeCompare(r2.kind);
      }
      return r1.namespace.localeCompare(r2.namespace);
    });
  }, [hpas, vpas, pdbs]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      `${r.namespace}/${r.name} ${r.kind} ${r.line1} ${r.line2} ${r.line3}`.toLowerCase().includes(q)
    );
  }, [rows, search]);

  return (
    <>
      <section class="grid gap-4 lg:grid-cols-[2fr,1.3fr] min-w-0">
        {/* Left: list */}
        <div class="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div class="flex flex-wrap items-center justify-between gap-3 mb-3">
            <div class="min-w-0">
              <h2 class="text-sm font-semibold text-slate-800">Autoscaling</h2>
              <p class="text-xs text-slate-500">HPA / VPA / PDB inventory with details panel.</p>
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

              <select
                class="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700"
                value={kindFilter}
                onChange={(e) => setKindFilter(e.target.value)}
              >
                <option value="all">All</option>
                <option value="hpa">HPA</option>
                <option value="vpa">VPA</option>
                <option value="pdb">PDB</option>
              </select>

              <input
                type="text"
                placeholder="Search…"
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

          {/* VPA optional warning */}
          {vpaWarning && (kindFilter === 'all' || kindFilter === 'vpa') && (
            <div class="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {vpaWarning}
            </div>
          )}

          <div class="flex items-center justify-between mb-2 text-[11px] text-slate-500 font-mono min-w-0">
            {loading ? (
              <span>loading autoscaling…</span>
            ) : (
              <span>{filtered.length} shown / {rows.length} total</span>
            )}
            <span class="text-[11px] text-slate-400">mode={isAdmin ? '"admin"' : '"readonly"'}</span>
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
                    <th class="text-left font-medium px-2 py-1">Kind</th>
                    <th class="text-left font-medium px-2 py-1">Name</th>
                    <th class="text-left font-medium px-2 py-1">Namespace</th>
                    <th class="text-left font-medium px-2 py-1">Summary</th>
                    <th class="text-left font-medium px-2 py-1">Age</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => (
                    <tr
                      key={`${r.kind}-${r.namespace}-${r.name}`}
                      class={
                        'cursor-pointer bg-slate-50 hover:bg-slate-100 ' +
                        (selected &&
                        selected.kind === r.kind &&
                        selected.namespace === r.namespace &&
                        selected.name === r.name
                          ? 'outline outline-1 outline-emerald-400/70'
                          : '')
                      }
                      onClick={() => setSelected({ kind: r.kind, namespace: r.namespace, name: r.name })}
                    >
                      <td class="px-2 py-1 align-top"><KindBadge kind={r.kind} /></td>
                      <td class="px-2 py-1 align-top">
                        <div class="font-mono text-[11px] text-slate-800">{r.name}</div>
                      </td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-600 font-mono">{r.namespace}</td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-700 font-mono">
                        <div class="break-all">{r.line1}</div>
                        {r.line2 && <div class="text-slate-600 break-all">{r.line2}</div>}
                        {r.line3 && <div class="text-slate-500 break-all">{r.line3}</div>}
                      </td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-600 font-mono">{r.age}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {filtered.length === 0 && (
                <div class="mt-3 text-xs text-slate-500">
                  No autoscaling resources match the current filters.
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right: details */}
        <div class="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div class="flex items-start justify-between mb-3 gap-2 min-w-0">
            <div class="min-w-0">
              <h2 class="text-sm font-semibold text-slate-800">Details</h2>
              <p class="text-xs text-slate-500">Full spec/status (and raw for VPA).</p>
            </div>

            {selected && (
              <div
                class="min-w-0 max-w-[16rem] text-[11px] text-slate-500 font-mono text-right truncate"
                title={`${selected.kind} ${selected.namespace}/${selected.name}`}
              >
                {selected.kind} {selected.namespace}/{selected.name}
              </div>
            )}
          </div>

          {!selected && (
            <div class="text-xs text-slate-500">
              No item selected. Click a row on the left to see details.
            </div>
          )}

          {selected && <DetailPanel detail={detail} loading={detailLoading} />}
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

function KindBadge({ kind }) {
  let cls = 'bg-slate-50 text-slate-700 border-slate-200';
  if (kind === 'HPA') cls = 'bg-amber-50 text-amber-800 border-amber-200';
  if (kind === 'VPA') cls = 'bg-indigo-50 text-indigo-700 border-indigo-200';
  if (kind === 'PDB') cls = 'bg-rose-50 text-rose-700 border-rose-200';

  return (
    <span class={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-mono ${cls}`}>
      {kind}
    </span>
  );
}

function DetailPanel({ detail, loading }) {
  if (loading) {
    return <div class="text-[11px] text-slate-500 font-mono">loading details…</div>;
  }
  if (!detail) {
    return <div class="text-xs text-slate-500">No details loaded.</div>;
  }

  const meta = detail.meta || {};
  const raw = detail.object || detail;

  return (
    <div class="space-y-4 text-xs min-w-0">
      <div class="flex flex-wrap items-center gap-3 min-w-0">
        <KindBadge kind={detail.kind || '-'} />
        {detail.apiVersion && <span class="font-mono text-slate-600 break-all">api={detail.apiVersion}</span>}
        <span class="font-mono text-slate-600 break-all">age={detail.age || '-'}</span>
      </div>

      <div class="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 flex flex-col gap-1 min-w-0">
        <div class="text-[11px] text-slate-600 font-mono break-all">uid={meta.uid || '-'}</div>
        <div class="text-[11px] text-slate-600 font-mono break-all">created={meta.creationTimestamp || '-'}</div>
        <div class="text-[11px] text-slate-600 font-mono break-all">rv={meta.resourceVersion || '-'}</div>
      </div>

      <div class="grid gap-4 md:grid-cols-2 min-w-0">
        <div class="min-w-0">
          <h3 class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em] mb-1">Labels</h3>
          <KeyValueList obj={meta.labels} emptyLabel="No labels." />
        </div>
        <div class="min-w-0">
          <h3 class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em] mb-1">Annotations</h3>
          <KeyValueList obj={meta.annotations} emptyLabel="No annotations." />
        </div>
      </div>

      <div class="min-w-0">
        <h3 class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em] mb-1">Raw</h3>
        <pre class="max-w-full text-[11px] bg-white border border-slate-200 rounded-xl p-3 overflow-auto font-mono text-slate-800 whitespace-pre-wrap break-all">
{JSON.stringify(raw, null, 2)}
        </pre>
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

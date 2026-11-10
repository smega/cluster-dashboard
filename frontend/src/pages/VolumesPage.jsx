// src/pages/VolumesPage.jsx
import { h } from 'preact';
import { useState, useEffect, useMemo } from 'preact/hooks';

export default function VolumesPage({ token, user }) {
  const [volumes, setVolumes] = useState([]);

  const [namespaceFilter, setNamespaceFilter] = useState(() => {
    if (typeof window === 'undefined') return 'all';
    return localStorage.getItem('volumes_ns') || 'all';
  });
  const [search, setSearch] = useState('');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadTick, setReloadTick] = useState(0);

  const [selected, setSelected] = useState(null);

  const [toasts, setToasts] = useState([]);

  const isAdmin = (user?.role || '').toLowerCase() === 'admin'; // currently read-only, but we keep it

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
      localStorage.setItem('volumes_ns', namespaceFilter);
    }
  }, [namespaceFilter]);

  // Load volumes
  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const res = await fetch('/api/volumes', {
          headers: { Authorization: `Bearer ${token}` }
        });
        const text = await res.text();
        if (!res.ok) {
          let msg = text || 'Failed to load volumes';
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
          throw new Error('Invalid JSON from /api/volumes');
        }

        if (cancelled) return;

        const items = Array.isArray(data.items) ? data.items : [];
        setVolumes(items);

        // Keep selection if it still exists
        if (selected) {
          const found = items.find(
            (v) => v.name === selected.name && v.namespace === selected.namespace
          );
          if (!found) {
            setSelected(null);
          }
        }
      } catch (err) {
        console.error('volumes fetch failed', err);
        const msg = err.message || 'Failed to load volumes';
        if (!cancelled) {
          setError(msg);
          setVolumes([]);
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

  // Namespaces from volumes
  const namespaces = useMemo(() => {
    const set = new Set(volumes.map((v) => v.namespace));
    return Array.from(set).sort();
  }, [volumes]);

  // Filtered volumes
  const filtered = useMemo(() => {
    const ns = namespaceFilter;
    const q = search.trim().toLowerCase();

    return volumes.filter((v) => {
      if (ns && ns !== 'all' && v.namespace !== ns) return false;
      if (!q) return true;

      const text = `${v.namespace}/${v.name} ${v.storageClass || ''} ${v.volumeName || ''}`.toLowerCase();
      return text.includes(q);
    });
  }, [volumes, namespaceFilter, search]);

  return (
    <>
      <section class="grid gap-4 lg:grid-cols-[2fr,1.3fr]">
        {/* Left: list */}
        <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div class="flex flex-wrap items-center justify-between gap-3 mb-3">
            <div>
              <h2 class="text-sm font-semibold text-slate-800">Volumes</h2>
              <p class="text-xs text-slate-500">
                PersistentVolumeClaims with PV and pod usage.
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
                placeholder="Search name / class…"
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
              <span>loading volumes…</span>
            ) : (
              <span>
                {filtered.length} shown / {volumes.length} total
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
                    <th class="text-left font-medium px-2 py-1">Status</th>
                    <th class="text-left font-medium px-2 py-1">Capacity</th>
                    <th class="text-left font-medium px-2 py-1">StorageClass</th>
                    <th class="text-left font-medium px-2 py-1">Pods</th>
                    <th class="text-left font-medium px-2 py-1">Age</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((v) => (
                    <tr
                      key={`${v.namespace}-${v.name}`}
                      class={
                        'cursor-pointer bg-slate-50 hover:bg-slate-100 ' +
                        (selected &&
                        selected.namespace === v.namespace &&
                        selected.name === v.name
                          ? 'outline outline-1 outline-emerald-400/70'
                          : '')
                      }
                      onClick={() => setSelected(v)}
                    >
                      <td class="px-2 py-1 align-top">
                        <div class="font-mono text-[11px] text-slate-800">
                          {v.name}
                        </div>
                      </td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-600 font-mono">
                        {v.namespace}
                      </td>
                      <td class="px-2 py-1 align-top text-[11px]">
                        <VolumeStatusBadge status={v.status} orphan={v.orphan} />
                      </td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-700 font-mono">
                        {v.capacity || '-'}
                      </td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-700 font-mono">
                        {v.storageClass || '-'}
                      </td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-700 font-mono">
                        {Array.isArray(v.podNames) && v.podNames.length > 0
                          ? `${v.podNames.length} pod(s)`
                          : '0 pods'}
                      </td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-600 font-mono">
                        {v.age}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {filtered.length === 0 && (
                <div class="mt-3 text-xs text-slate-500">
                  No volumes match the current filters.
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
                Volume details
              </h2>
              <p class="text-xs text-slate-500">
                PVC status, PV mapping, pod usage, labels and annotations.
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
              No volume selected. Click a row on the left to see details.
            </div>
          )}

          {selected && (
            <VolumeDetailPanel volume={selected} isAdmin={isAdmin} />
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

function VolumeStatusBadge({ status, orphan }) {
  const s = (status || '').toLowerCase();
  let cls = 'bg-slate-100 text-slate-700 border-slate-200';
  let label = status || 'Unknown';

  if (orphan) {
    cls = 'bg-rose-50 text-rose-700 border-rose-200';
    if (!label) label = 'Orphan';
  } else if (s === 'bound') {
    cls = 'bg-emerald-50 text-emerald-700 border-emerald-200';
  } else if (s === 'pending') {
    cls = 'bg-amber-50 text-amber-700 border-amber-200';
  } else if (s === 'lost') {
    cls = 'bg-rose-50 text-rose-700 border-rose-200';
  }

  return (
    <span class={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-mono ${cls}`}>
      {label}
      {orphan && ' (no pods)'}
    </span>
  );
}

function VolumeDetailPanel({ volume, isAdmin }) {
  const accessModes = volume.accessModes || [];
  const podNames = volume.podNames || [];
  const nodeNames = volume.nodeNames || [];
  const labels = volume.labels || {};
  const annotations = volume.annotations || {};

  return (
    <div class="space-y-4 text-xs">
      {/* Summary */}
      <div class="flex flex-wrap items-center gap-3">
        <VolumeStatusBadge status={volume.status} orphan={volume.orphan} />
        <span class="font-mono text-slate-600">
          sc={volume.storageClass || '-'}
        </span>
        <span class="font-mono text-slate-600">
          cap={volume.capacity || '-'}
        </span>
        <span class="font-mono text-slate-600">
          mode={volume.volumeMode || '-'}
        </span>
        <span class="font-mono text-slate-600">
          age={volume.age}
        </span>
        {volume.volumeName && (
          <span class="font-mono text-slate-600">
            pv={volume.volumeName}
          </span>
        )}
      </div>

      {/* PV details */}
      <div class="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 flex flex-col gap-1">
        <div class="flex items-center justify-between">
          <div class="text-[11px] text-slate-600 font-mono">
            mode={isAdmin ? '"admin"' : '"readonly"'}
          </div>
          {volume.pvPhase && (
            <span class="font-mono text-[11px] text-slate-600">
              pvPhase={volume.pvPhase}
            </span>
          )}
        </div>
        {volume.pvReclaimPolicy && (
          <div class="text-[11px] text-slate-600 font-mono">
            reclaim={volume.pvReclaimPolicy}
          </div>
        )}
        {accessModes.length > 0 && (
          <div class="text-[11px] text-slate-600">
            accessModes:{' '}
            <span class="font-mono">
              {accessModes.join(', ')}
            </span>
          </div>
        )}
      </div>

      {/* Pod usage */}
      <div>
        <h3 class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em] mb-1">
          Pod usage
        </h3>
        {podNames.length === 0 ? (
          <div class="text-[11px] text-slate-500">
            No pods currently reference this PVC.
          </div>
        ) : (
          <div class="space-y-1">
            {podNames.map((p) => (
              <div key={p} class="flex items-center justify-between">
                <span class="font-mono text-slate-800">{p}</span>
              </div>
            ))}
          </div>
        )}
        {nodeNames.length > 0 && (
          <div class="mt-2 text-[11px] text-slate-600">
            nodes:{' '}
            <span class="font-mono">
              {nodeNames.join(', ')}
            </span>
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

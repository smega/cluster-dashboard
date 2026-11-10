// src/pages/StoragePage.jsx
import { h } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';

export default function StoragePage({ token, user }) {
  const [view, setView] = useState(() => {
    if (typeof window === 'undefined') return 'pvs';
    return localStorage.getItem('storage_view') || 'pvs';
  });

  const [namespaceFilter, setNamespaceFilter] = useState(() => {
    if (typeof window === 'undefined') return 'all';
    return localStorage.getItem('storage_ns') || 'all';
  });

  const [namespaces, setNamespaces] = useState([]);

  const [items, setItems] = useState([]);
  const [warning, setWarning] = useState('');

  const [search, setSearch] = useState('');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadTick, setReloadTick] = useState(0);

  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

  const [toasts, setToasts] = useState([]);

  const isAdmin = (user?.role || '').toLowerCase() === 'admin'; // still read-only for storage

  const pushToast = (type, message) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  };

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('storage_view', view);
    }
  }, [view]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('storage_ns', namespaceFilter);
    }
  }, [namespaceFilter]);

  async function fetchOptionalList(url, token) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  // If route doesn't exist (older backend), treat as "not available"
  if (res.status === 404) {
    return { items: [], available: false, warning: `Not available: ${url} (404)` };
  }

  const text = await res.text();

  // Normal errors still show as errors
  if (!res.ok) {
    let msg = text || `Request failed: ${res.status}`;
    try {
      const obj = JSON.parse(text);
      msg = obj.error || msg;
    } catch {}
    throw new Error(msg);
  }

  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Invalid JSON from ${url}`);
  }

  return {
    items: Array.isArray(data.items) ? data.items : [],
    available: data.available !== false,
    warning: data.warning || "",
  };
}


  // Load namespaces for dropdowns (snapshots uses it)
  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    const load = async () => {
      try {
        const res = await fetch('/api/kube/namespaces', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const txt = await res.text();
        if (!res.ok) throw new Error(txt || 'Failed to load namespaces');

        const data = JSON.parse(txt);
        const arr = Array.isArray(data.items) ? data.items : Array.isArray(data.namespaces) ? data.namespaces : [];
        if (!cancelled) setNamespaces(arr.sort());
      } catch (e) {
        // not fatal; we can still operate
        console.warn('namespaces load failed', e);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const listEndpoint = useMemo(() => {
    if (view === 'pvs') return '/api/kube/storage/pvs';
    if (view === 'storageclasses') return '/api/kube/storage/storageclasses';
    if (view === 'csidrivers') return '/api/kube/storage/csidrivers';
    if (view === 'snapshots') {
      const ns = namespaceFilter || 'all';
      return `/api/kube/storage/snapshots?namespace=${encodeURIComponent(ns)}`;
    }
    if (view === 'snapshotclasses') return '/api/kube/storage/snapshotclasses';
    return '/api/kube/storage/pvs';
  }, [view, namespaceFilter]);

  // Load list
  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError('');
      setWarning('');
      try {
        const res = await fetch(listEndpoint, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const text = await res.text();
        if (!res.ok) {
          let msg = text || 'Failed to load storage items';
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
          throw new Error(`Invalid JSON from ${listEndpoint}`);
        }

        if (cancelled) return;

        const list = Array.isArray(data.items) ? data.items : [];
        setItems(list);
        setWarning(data.warning || '');

        // keep selection if still exists (by key)
        if (selected) {
          const still = list.find((x) => keyOf(x, view) === keyOf(selected, view));
          if (!still) {
            setSelected(null);
            setDetail(null);
          }
        }
      } catch (err) {
        console.error('storage list fetch failed', err);
        const msg = err.message || 'Failed to load storage items';
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => {
      cancelled = true;
    };
  }, [token, listEndpoint, reloadTick]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;

    return items.filter((x) => {
      const text = storageSearchText(x, view).toLowerCase();
      return text.includes(q);
    });
  }, [items, search, view]);

  const loadDetail = async (row) => {
    setSelected(row);
    setDetail(null);
    setDetailError('');
    setDetailLoading(true);

    try {
      const url = detailEndpoint(row, view);
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const text = await res.text();
      if (!res.ok) {
        let msg = text || 'Failed to load detail';
        try {
          const obj = JSON.parse(text);
          msg = obj.error || msg;
        } catch {}
        throw new Error(msg);
      }
      const data = JSON.parse(text);
      setDetail(data);
    } catch (err) {
      console.error('storage detail fetch failed', err);
      const msg = err.message || 'Failed to load detail';
      setDetailError(msg);
      pushToast('error', msg);
    } finally {
      setDetailLoading(false);
    }
  };

  const viewLabel = {
    pvs: 'PersistentVolumes',
    storageclasses: 'StorageClasses',
    csidrivers: 'CSIDrivers',
    snapshots: 'VolumeSnapshots',
    snapshotclasses: 'VolumeSnapshotClasses',
  }[view];

  return (
    <>
      <section class="grid gap-4 lg:grid-cols-[2fr,1.3fr]">
        {/* Left */}
        <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div class="flex flex-wrap items-center justify-between gap-3 mb-3">
            <div>
              <h2 class="text-sm font-semibold text-slate-800">Storage</h2>
              <p class="text-xs text-slate-500">
                PVs, StorageClasses, CSIDrivers and snapshot inventory (read-only).
              </p>
            </div>

            <div class="flex flex-wrap items-center gap-2 text-xs">
              <select
                class="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700"
                value={view}
                onChange={(e) => {
                  setView(e.target.value);
                  setSelected(null);
                  setDetail(null);
                  setSearch('');
                }}
              >
                <option value="pvs">PVs</option>
                <option value="storageclasses">StorageClasses</option>
                <option value="csidrivers">CSIDrivers</option>
                <option value="snapshots">VolumeSnapshots</option>
                <option value="snapshotclasses">VolumeSnapshotClasses</option>
              </select>

              <select
                class={
                  'rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 ' +
                  (view !== 'snapshots' ? 'opacity-60' : '')
                }
                value={namespaceFilter}
                onChange={(e) => setNamespaceFilter(e.target.value)}
                disabled={view !== 'snapshots'}
              >
                <option value="all">All namespaces</option>
                {(namespaces || []).map((ns) => (
                  <option key={ns} value={ns}>{ns}</option>
                ))}
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

          <div class="flex items-center justify-between mb-2 text-[11px] text-slate-500 font-mono">
            {loading ? (
              <span>loading {viewLabel?.toLowerCase()}…</span>
            ) : (
              <span>{filtered.length} shown / {items.length} total</span>
            )}
            <span>mode={isAdmin ? '"admin"' : '"readonly"'}</span>
          </div>

          {warning && !loading && (
            <div class="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {warning}
            </div>
          )}

          {error && !loading && (
            <div class="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {error}
            </div>
          )}

          {!loading && !error && (
            <div class="overflow-x-auto">
              {view === 'pvs' && (
                <TablePVs rows={filtered} selected={selected} onSelect={loadDetail} />
              )}
              {view === 'storageclasses' && (
                <TableStorageClasses rows={filtered} selected={selected} onSelect={loadDetail} />
              )}
              {view === 'csidrivers' && (
                <TableCSIDrivers rows={filtered} selected={selected} onSelect={loadDetail} />
              )}
              {view === 'snapshots' && (
                <TableSnapshots rows={filtered} selected={selected} onSelect={loadDetail} />
              )}
              {view === 'snapshotclasses' && (
                <TableSnapshotClasses rows={filtered} selected={selected} onSelect={loadDetail} />
              )}

              {filtered.length === 0 && (
                <div class="mt-3 text-xs text-slate-500">
                  No items match the current filters.
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right */}
        <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm max-w-full overflow-hidden">
          <div class="flex items-center justify-between mb-3">
            <div>
              <h2 class="text-sm font-semibold text-slate-800">Details</h2>
              <p class="text-xs text-slate-500">
                Metadata, spec/status and raw object view.
              </p>
            </div>
            {selected && (
              <div class="text-[11px] text-slate-500 font-mono text-right max-w-[60%] truncate">
                {prettyKey(selected, view)}
              </div>
            )}
          </div>

          {!selected && (
            <div class="text-xs text-slate-500">
              No item selected. Click a row on the left to see details.
            </div>
          )}

          {selected && detailLoading && (
            <div class="text-xs text-slate-500 font-mono">loading detail…</div>
          )}

          {selected && detailError && !detailLoading && (
            <div class="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {detailError}
            </div>
          )}

          {selected && detail && !detailLoading && !detailError && (
            <DetailPanel view={view} detail={detail} />
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

/* --------------------------
   Tables
-------------------------- */

function rowClass(selected, row, view) {
  const isSel = selected && keyOf(selected, view) === keyOf(row, view);
  return (
    'cursor-pointer bg-slate-50 hover:bg-slate-100 ' +
    (isSel ? 'outline outline-1 outline-emerald-400/70' : '')
  );
}

function TablePVs({ rows, selected, onSelect }) {
  return (
    <table class="min-w-full text-xs border-separate border-spacing-y-[3px]">
      <thead>
        <tr class="text-[11px] text-slate-500">
          <th class="text-left font-medium px-2 py-1">Name</th>
          <th class="text-left font-medium px-2 py-1">Phase</th>
          <th class="text-left font-medium px-2 py-1">Capacity</th>
          <th class="text-left font-medium px-2 py-1">Claim</th>
          <th class="text-left font-medium px-2 py-1">StorageClass</th>
          <th class="text-left font-medium px-2 py-1">Reclaim</th>
          <th class="text-left font-medium px-2 py-1">Age</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.name} class={rowClass(selected, r, 'pvs')} onClick={() => onSelect(r)}>
            <td class="px-2 py-1 font-mono text-[11px] text-slate-800">{r.name}</td>
            <td class="px-2 py-1 text-[11px]"><PhaseBadge phase={r.phase} /></td>
            <td class="px-2 py-1 font-mono text-[11px] text-slate-700">{r.capacity || '-'}</td>
            <td class="px-2 py-1 font-mono text-[11px] text-slate-600">{r.claim || '-'}</td>
            <td class="px-2 py-1 font-mono text-[11px] text-slate-700">{r.storageClass || '-'}</td>
            <td class="px-2 py-1 font-mono text-[11px] text-slate-700">{r.reclaim || '-'}</td>
            <td class="px-2 py-1 font-mono text-[11px] text-slate-600">{r.age}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TableStorageClasses({ rows, selected, onSelect }) {
  return (
    <table class="min-w-full text-xs border-separate border-spacing-y-[3px]">
      <thead>
        <tr class="text-[11px] text-slate-500">
          <th class="text-left font-medium px-2 py-1">Name</th>
          <th class="text-left font-medium px-2 py-1">Provisioner</th>
          <th class="text-left font-medium px-2 py-1">Binding</th>
          <th class="text-left font-medium px-2 py-1">Reclaim</th>
          <th class="text-left font-medium px-2 py-1">Expand</th>
          <th class="text-left font-medium px-2 py-1">Params</th>
          <th class="text-left font-medium px-2 py-1">Age</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.name} class={rowClass(selected, r, 'storageclasses')} onClick={() => onSelect(r)}>
            <td class="px-2 py-1 font-mono text-[11px] text-slate-800">{r.name}</td>
            <td class="px-2 py-1 font-mono text-[11px] text-slate-700">{r.provisioner || '-'}</td>
            <td class="px-2 py-1 font-mono text-[11px] text-slate-700">{r.volumeBindingMode || '-'}</td>
            <td class="px-2 py-1 font-mono text-[11px] text-slate-700">{r.reclaimPolicy || '-'}</td>
            <td class="px-2 py-1 font-mono text-[11px] text-slate-700">{String(!!r.allowExpansion)}</td>
            <td class="px-2 py-1 font-mono text-[11px] text-slate-700">{r.parameters ?? 0}</td>
            <td class="px-2 py-1 font-mono text-[11px] text-slate-600">{r.age}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TableCSIDrivers({ rows, selected, onSelect }) {
  return (
    <table class="min-w-full text-xs border-separate border-spacing-y-[3px]">
      <thead>
        <tr class="text-[11px] text-slate-500">
          <th class="text-left font-medium px-2 py-1">Name</th>
          <th class="text-left font-medium px-2 py-1">Attach</th>
          <th class="text-left font-medium px-2 py-1">PodInfo</th>
          <th class="text-left font-medium px-2 py-1">StorageCap</th>
          <th class="text-left font-medium px-2 py-1">FSGroupPolicy</th>
          <th class="text-left font-medium px-2 py-1">Age</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.name} class={rowClass(selected, r, 'csidrivers')} onClick={() => onSelect(r)}>
            <td class="px-2 py-1 font-mono text-[11px] text-slate-800">{r.name}</td>
            <td class="px-2 py-1 font-mono text-[11px] text-slate-700">{r.attachRequired || '-'}</td>
            <td class="px-2 py-1 font-mono text-[11px] text-slate-700">{r.podInfoOnMount || '-'}</td>
            <td class="px-2 py-1 font-mono text-[11px] text-slate-700">{r.storageCapacity || '-'}</td>
            <td class="px-2 py-1 font-mono text-[11px] text-slate-700">{r.fsGroupPolicy || '-'}</td>
            <td class="px-2 py-1 font-mono text-[11px] text-slate-600">{r.age}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TableSnapshots({ rows, selected, onSelect }) {
  return (
    <table class="min-w-full text-xs border-separate border-spacing-y-[3px]">
      <thead>
        <tr class="text-[11px] text-slate-500">
          <th class="text-left font-medium px-2 py-1">Name</th>
          <th class="text-left font-medium px-2 py-1">Namespace</th>
          <th class="text-left font-medium px-2 py-1">Ready</th>
          <th class="text-left font-medium px-2 py-1">Source</th>
          <th class="text-left font-medium px-2 py-1">Class</th>
          <th class="text-left font-medium px-2 py-1">Restore</th>
          <th class="text-left font-medium px-2 py-1">Age</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr
            key={`${r.namespace}-${r.name}`}
            class={rowClass(selected, r, 'snapshots')}
            onClick={() => onSelect(r)}
          >
            <td class="px-2 py-1 font-mono text-[11px] text-slate-800">{r.name}</td>
            <td class="px-2 py-1 font-mono text-[11px] text-slate-600">{r.namespace}</td>
            <td class="px-2 py-1 text-[11px]"><ReadyBadge v={r.ready} /></td>
            <td class="px-2 py-1 font-mono text-[11px] text-slate-700">{r.source || '-'}</td>
            <td class="px-2 py-1 font-mono text-[11px] text-slate-700">{r.className || '-'}</td>
            <td class="px-2 py-1 font-mono text-[11px] text-slate-700">{r.restoreSize || '-'}</td>
            <td class="px-2 py-1 font-mono text-[11px] text-slate-600">{r.age}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TableSnapshotClasses({ rows, selected, onSelect }) {
  return (
    <table class="min-w-full text-xs border-separate border-spacing-y-[3px]">
      <thead>
        <tr class="text-[11px] text-slate-500">
          <th class="text-left font-medium px-2 py-1">Name</th>
          <th class="text-left font-medium px-2 py-1">Driver</th>
          <th class="text-left font-medium px-2 py-1">DeletionPolicy</th>
          <th class="text-left font-medium px-2 py-1">Default</th>
          <th class="text-left font-medium px-2 py-1">Params</th>
          <th class="text-left font-medium px-2 py-1">Age</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.name} class={rowClass(selected, r, 'snapshotclasses')} onClick={() => onSelect(r)}>
            <td class="px-2 py-1 font-mono text-[11px] text-slate-800">{r.name}</td>
            <td class="px-2 py-1 font-mono text-[11px] text-slate-700">{r.driver || '-'}</td>
            <td class="px-2 py-1 font-mono text-[11px] text-slate-700">{r.deletionPolicy || '-'}</td>
            <td class="px-2 py-1 font-mono text-[11px] text-slate-700">{String(!!r.isDefault)}</td>
            <td class="px-2 py-1 font-mono text-[11px] text-slate-700">{r.parameters ?? 0}</td>
            <td class="px-2 py-1 font-mono text-[11px] text-slate-600">{r.age}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* --------------------------
   Detail Panel
-------------------------- */

function DetailPanel({ view, detail }) {
  const meta = detail.meta || {};
  const obj = detail.object || detail.objectRaw || null;

  // For PV we return spec/status separately
  const raw = obj || detail;

  return (
    <div class="space-y-4 text-xs max-w-full">
      <div class="flex flex-wrap items-center gap-3">
        <span class="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-mono bg-slate-100 text-slate-700 border-slate-200">
          kind={detail.kind || '-'}
        </span>
        {detail.apiVersion && (
          <span class="font-mono text-[11px] text-slate-600">
            api={detail.apiVersion}
          </span>
        )}
        {detail.age && (
          <span class="font-mono text-[11px] text-slate-600">
            age={detail.age}
          </span>
        )}
      </div>

      <div class="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 space-y-1">
        <div class="text-[11px] text-slate-600 font-mono">name={detail.name}</div>
        {detail.namespace ? (
          <div class="text-[11px] text-slate-600 font-mono">namespace={detail.namespace}</div>
        ) : (
          <div class="text-[11px] text-slate-600 font-mono">scope="cluster"</div>
        )}
        {meta.resourceVersion && (
          <div class="text-[11px] text-slate-600 font-mono">rv={meta.resourceVersion}</div>
        )}
        {meta.uid && (
          <div class="text-[11px] text-slate-600 font-mono">uid={meta.uid}</div>
        )}
      </div>

      {detail.summary && (
        <div>
          <h3 class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em] mb-1">
            Summary
          </h3>
          <KeyValueList obj={detail.summary} emptyLabel="No summary." />
        </div>
      )}

      {(detail.spec || detail.status) && (
        <div class="grid gap-4 md:grid-cols-2">
          <div>
            <h3 class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em] mb-1">
              Spec
            </h3>
            <JsonBlock data={detail.spec} />
          </div>
          <div>
            <h3 class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em] mb-1">
              Status
            </h3>
            <JsonBlock data={detail.status} />
          </div>
        </div>
      )}

      {meta.labels && (
        <div>
          <h3 class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em] mb-1">
            Labels
          </h3>
          <KeyValueList obj={meta.labels} emptyLabel="No labels." />
        </div>
      )}

      {meta.annotations && (
        <div>
          <h3 class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em] mb-1">
            Annotations
          </h3>
          <KeyValueList obj={meta.annotations} emptyLabel="No annotations." />
        </div>
      )}

      <div>
        <h3 class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em] mb-1">
          Raw
        </h3>
        <JsonBlock data={raw} />
      </div>
    </div>
  );
}

function JsonBlock({ data }) {
  const text = safeJson(data);
  return (
    <pre class="max-w-full overflow-x-auto rounded-xl border border-slate-200 bg-white px-3 py-2 text-[11px] text-slate-800 font-mono whitespace-pre">
      {text}
    </pre>
  );
}

function safeJson(x) {
  try {
    return JSON.stringify(x ?? null, null, 2);
  } catch {
    return String(x);
  }
}

function PhaseBadge({ phase }) {
  const s = (phase || '').toLowerCase();
  let cls = 'bg-slate-100 text-slate-700 border-slate-200';
  if (s === 'bound' || s === 'available') cls = 'bg-emerald-50 text-emerald-700 border-emerald-200';
  if (s === 'failed') cls = 'bg-rose-50 text-rose-700 border-rose-200';
  return (
    <span class={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-mono ${cls}`}>
      {phase || 'Unknown'}
    </span>
  );
}

function ReadyBadge({ v }) {
  const s = String(v || '-').toLowerCase();
  let cls = 'bg-slate-100 text-slate-700 border-slate-200';
  if (s === 'true') cls = 'bg-emerald-50 text-emerald-700 border-emerald-200';
  if (s === 'false') cls = 'bg-rose-50 text-rose-700 border-rose-200';
  return (
    <span class={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-mono ${cls}`}>
      {v || '-'}
    </span>
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

/* --------------------------
   Helpers
-------------------------- */

function keyOf(x, view) {
  if (!x) return '';
  if (view === 'snapshots') return `${x.namespace}/${x.name}`;
  return x.name || '';
}

function prettyKey(x, view) {
  if (!x) return '';
  if (view === 'snapshots') return `${x.namespace}/${x.name}`;
  return x.name || '';
}

function detailEndpoint(x, view) {
  if (view === 'pvs') return `/api/kube/storage/pvs/${encodeURIComponent(x.name)}`;
  if (view === 'storageclasses') return `/api/kube/storage/storageclasses/${encodeURIComponent(x.name)}`;
  if (view === 'csidrivers') return `/api/kube/storage/csidrivers/${encodeURIComponent(x.name)}`;
  if (view === 'snapshots') {
    return `/api/kube/storage/snapshots/${encodeURIComponent(x.namespace)}/${encodeURIComponent(x.name)}`;
  }
  if (view === 'snapshotclasses') return `/api/kube/storage/snapshotclasses/${encodeURIComponent(x.name)}`;
  return `/api/kube/storage/pvs/${encodeURIComponent(x.name)}`;
}

function storageSearchText(x, view) {
  if (!x) return '';
  if (view === 'pvs') return `${x.name} ${x.phase} ${x.capacity} ${x.claim} ${x.storageClass} ${x.reclaim}`;
  if (view === 'storageclasses') return `${x.name} ${x.provisioner} ${x.reclaimPolicy} ${x.volumeBindingMode}`;
  if (view === 'csidrivers') return `${x.name} ${x.attachRequired} ${x.podInfoOnMount} ${x.storageCapacity} ${x.fsGroupPolicy}`;
  if (view === 'snapshots') return `${x.namespace}/${x.name} ${x.ready} ${x.source} ${x.className} ${x.restoreSize} ${x.error || ''}`;
  if (view === 'snapshotclasses') return `${x.name} ${x.driver} ${x.deletionPolicy} default=${x.isDefault}`;
  return `${x.name || ''}`;
}

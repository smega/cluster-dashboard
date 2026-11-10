// src/pages/NodesPage.jsx
import { h } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';

export default function NodesPage({ token, user }) {
  const [nodes, setNodes] = useState([]);
  const [pools, setPools] = useState([]);
  const [topCPU, setTopCPU] = useState([]);
  const [topMem, setTopMem] = useState([]);

  const [metricsAvailable, setMetricsAvailable] = useState(false);
  const [metricsWarning, setMetricsWarning] = useState('');

  const [poolFilter, setPoolFilter] = useState(() => {
    if (typeof window === 'undefined') return 'all';
    return localStorage.getItem('nodes_pool') || 'all';
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

  const pushToast = (type, message) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  };

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('nodes_pool', poolFilter);
    }
  }, [poolFilter]);

  // Load nodes
  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const res = await fetch('/api/nodes', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const text = await res.text();
        if (!res.ok) {
          let msg = text || 'Failed to load nodes';
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
          throw new Error('Invalid JSON from /api/nodes');
        }

        if (cancelled) return;

        const items = Array.isArray(data.items) ? data.items : [];
        setNodes(items);
        setPools(Array.isArray(data.pools) ? data.pools : []);
        setTopCPU(Array.isArray(data.topCPU) ? data.topCPU : []);
        setTopMem(Array.isArray(data.topMem) ? data.topMem : []);
        setMetricsAvailable(Boolean(data.metricsAvailable));
        setMetricsWarning(data.metricsWarning || '');

        // keep selection if still exists
        if (selected) {
          const found = items.find((n) => n.name === selected.name);
          if (!found) {
            setSelected(null);
            setDetail(null);
          }
        }
      } catch (err) {
        console.error('nodes fetch failed', err);
        const msg = err.message || 'Failed to load nodes';
        if (!cancelled) {
          setError(msg);
          setNodes([]);
          setPools([]);
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
  }, [token, reloadTick]);

  // Filtered nodes
  const filtered = useMemo(() => {
    const pf = poolFilter;
    const q = search.trim().toLowerCase();

    return nodes.filter((n) => {
      if (pf !== 'all' && (n.pool || 'unknown') !== pf) return false;
      if (!q) return true;

      const text = `${n.name} ${(n.pool || '')} ${(n.zone || '')} ${(n.instanceType || '')}`.toLowerCase();
      return text.includes(q);
    });
  }, [nodes, poolFilter, search]);

  const poolOptions = useMemo(() => {
    // derive from returned pools (best), fallback from nodes
    const set = new Set();
    for (const p of pools) set.add(p.pool);
    if (set.size === 0) {
      for (const n of nodes) set.add(n.pool || 'unknown');
    }
    return Array.from(set).sort();
  }, [pools, nodes]);

  const handleSelect = async (n) => {
    setSelected(n);
    setDetail(null);
    setDetailError('');
    setDetailLoading(true);

    try {
      const res = await fetch(`/api/nodes/${encodeURIComponent(n.name)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const text = await res.text();
      if (!res.ok) {
        let msg = text || 'Failed to load node detail';
        try {
          const obj = JSON.parse(text);
          msg = obj.error || msg;
        } catch {}
        throw new Error(msg);
      }
      const data = JSON.parse(text);
      setDetail(data);
    } catch (err) {
      console.error('node detail fetch failed', err);
      const msg = err.message || 'Failed to load node detail';
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
              <h2 class="text-sm font-semibold text-slate-800">Nodes</h2>
              <p class="text-xs text-slate-500">
                Readiness, taints, versions, OS image, and optional CPU/memory usage.
              </p>
            </div>

            <div class="flex flex-wrap items-center gap-2 text-xs">
              <select
                class="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700"
                value={poolFilter}
                onChange={(e) => setPoolFilter(e.target.value)}
              >
                <option value="all">All pools</option>
                {poolOptions.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>

              <input
                type="text"
                placeholder="Search node / pool / zone…"
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

          {!metricsAvailable && metricsWarning && (
            <div class="mb-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
              {metricsWarning}
            </div>
          )}

          {/* Pools summary chips */}
          {pools.length > 0 && (
            <div class="mb-3 flex flex-wrap gap-2">
              {pools.map((p) => (
                <button
                  key={p.pool}
                  type="button"
                  class={
                    'rounded-full border px-3 py-1 text-[11px] font-mono ' +
                    ((poolFilter === p.pool)
                      ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50')
                  }
                  onClick={() => setPoolFilter(poolFilter === p.pool ? 'all' : p.pool)}
                  title="Filter by pool"
                >
                  {p.pool} • {p.readyCount}/{p.nodeCount} ready
                  {metricsAvailable && (
                    <span class="ml-2 text-slate-500">
                      cpu~{fmtPct(p.avgCpuPct)} mem~{fmtPct(p.avgMemPct)}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}

          {/* Top nodes */}
          {metricsAvailable && (topCPU.length > 0 || topMem.length > 0) && (
            <div class="mb-3 grid gap-3 md:grid-cols-2">
              <MiniTop title="Top CPU" items={topCPU} onPick={handleSelect} />
              <MiniTop title="Top Memory" items={topMem} onPick={handleSelect} />
            </div>
          )}

          <div class="flex items-center justify-between mb-2 text-[11px] text-slate-500 font-mono">
            {loading ? (
              <span>loading nodes…</span>
            ) : (
              <span>
                {filtered.length} shown / {nodes.length} total
              </span>
            )}
            <span>metrics={metricsAvailable ? 'on' : 'off'}</span>
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
                    <th class="text-left font-medium px-2 py-1">Node</th>
                    <th class="text-left font-medium px-2 py-1">Pool</th>
                    <th class="text-left font-medium px-2 py-1">Ready</th>
                    <th class="text-left font-medium px-2 py-1">Sched</th>
                    <th class="text-left font-medium px-2 py-1">CPU%</th>
                    <th class="text-left font-medium px-2 py-1">Mem%</th>
                    <th class="text-left font-medium px-2 py-1">Taints</th>
                    <th class="text-left font-medium px-2 py-1">Kubelet</th>
                    <th class="text-left font-medium px-2 py-1">OS</th>
                    <th class="text-left font-medium px-2 py-1">Age</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((n) => (
                    <tr
                      key={n.name}
                      class={
                        'cursor-pointer bg-slate-50 hover:bg-slate-100 ' +
                        (selected && selected.name === n.name
                          ? 'outline outline-1 outline-emerald-400/70'
                          : '')
                      }
                      onClick={() => handleSelect(n)}
                    >
                      <td class="px-2 py-1 align-top">
                        <div class="font-mono text-[11px] text-slate-800">
                          {n.name}
                        </div>
                        {(n.zone || n.instanceType) && (
                          <div class="text-[11px] text-slate-500 font-mono">
                            {n.zone || '-'} • {n.instanceType || '-'}
                          </div>
                        )}
                      </td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-600 font-mono">
                        {n.pool || 'unknown'}
                      </td>
                      <td class="px-2 py-1 align-top text-[11px]">
                        <ReadyBadge ready={n.ready} reason={n.readyReason} />
                      </td>
                      <td class="px-2 py-1 align-top text-[11px]">
                        <SchedBadge sched={n.schedulable} />
                      </td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-700 font-mono">
                        {metricsAvailable ? fmtPct(n.cpuPct) : '-'}
                      </td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-700 font-mono">
                        {metricsAvailable ? fmtPct(n.memPct) : '-'}
                      </td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-700 font-mono">
                        {n.taintsCount}
                      </td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-600 font-mono">
                        {n.kubeletVersion || '-'}
                      </td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-600 font-mono">
                        {shortOS(n.osImage)}
                      </td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-600 font-mono">
                        {n.age}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {filtered.length === 0 && (
                <div class="mt-3 text-xs text-slate-500">
                  No nodes match the current filters.
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right: details */}
        <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div class="flex items-center justify-between mb-3">
            <div>
              <h2 class="text-sm font-semibold text-slate-800">Node details</h2>
              <p class="text-xs text-slate-500">
                Conditions, versions, taints, labels, capacity/allocatable and metrics (if available).
              </p>
            </div>
            {selected && (
              <div class="text-[11px] text-slate-500 font-mono text-right">
                {selected.name}
              </div>
            )}
          </div>

          {!selected && (
            <div class="text-xs text-slate-500">
              No node selected. Click a row on the left to see details.
            </div>
          )}

          {selected && detailLoading && (
            <div class="text-xs text-slate-500 font-mono">loading node detail…</div>
          )}

          {selected && detailError && !detailLoading && (
            <div class="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {detailError}
            </div>
          )}

          {selected && detail && !detailLoading && !detailError && (
            <NodeDetailPanel detail={detail} />
          )}
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

function MiniTop({ title, items, onPick }) {
  return (
    <div class="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
      <div class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em] mb-1">
        {title}
      </div>
      {items.length === 0 ? (
        <div class="text-[11px] text-slate-500">No data.</div>
      ) : (
        <div class="space-y-1">
          {items.map((n) => (
            <button
              key={n.name}
              type="button"
              class="w-full text-left rounded-lg border border-slate-200 bg-white px-2 py-1 hover:bg-slate-100"
              onClick={() => onPick(n)}
            >
              <div class="flex items-center justify-between">
                <span class="font-mono text-[11px] text-slate-800">{n.name}</span>
                <span class="font-mono text-[11px] text-slate-600">
                  cpu={fmtPct(n.cpuPct)} mem={fmtPct(n.memPct)}
                </span>
              </div>
              <div class="text-[11px] text-slate-500 font-mono">
                pool={n.pool || 'unknown'}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ReadyBadge({ ready, reason }) {
  const cls = ready
    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
    : 'bg-rose-50 text-rose-700 border-rose-200';

  return (
    <span
      class={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-mono ${cls}`}
      title={!ready && reason ? reason : ''}
    >
      {ready ? 'Ready' : 'NotReady'}
      {!ready && reason ? ` (${reason})` : ''}
    </span>
  );
}

function SchedBadge({ sched }) {
  const cls = sched
    ? 'bg-slate-100 text-slate-700 border-slate-200'
    : 'bg-amber-50 text-amber-700 border-amber-200';
  return (
    <span class={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-mono ${cls}`}>
      {sched ? 'Sched' : 'Unsched'}
    </span>
  );
}

function NodeDetailPanel({ detail }) {
  const labels = detail.labels || {};
  const taints = detail.taints || [];
  const conditions = detail.conditions || [];
  const addresses = detail.addresses || [];

  return (
    <div class="space-y-4 text-xs">
      {/* Summary */}
      <div class="flex flex-wrap items-center gap-3">
        <ReadyBadge ready={detail.ready} reason={detail.readyReason} />
        <SchedBadge sched={detail.schedulable} />
        <span class="font-mono text-slate-600">pool={detail.pool || 'unknown'}</span>
        {detail.region && <span class="font-mono text-slate-600">region={detail.region}</span>}
        {detail.zone && <span class="font-mono text-slate-600">zone={detail.zone}</span>}
        {detail.instanceType && <span class="font-mono text-slate-600">type={detail.instanceType}</span>}
        <span class="font-mono text-slate-600">age={detail.age}</span>
      </div>

      {/* Versions */}
      <div class="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 space-y-1">
        <div class="text-[11px] text-slate-600 font-mono">kubelet={detail.kubeletVersion || '-'}</div>
        <div class="text-[11px] text-slate-600 font-mono">os={detail.osImage || '-'}</div>
        <div class="text-[11px] text-slate-600 font-mono">kernel={detail.kernelVersion || '-'}</div>
        <div class="text-[11px] text-slate-600 font-mono">runtime={detail.containerRuntime || '-'}</div>
      </div>

      {/* Capacity / Metrics */}
      <div class="rounded-xl border border-slate-200 bg-white px-3 py-2">
        <div class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em] mb-2">
          Capacity & usage
        </div>

        <div class="grid gap-2 md:grid-cols-2">
          <div class="text-[11px] text-slate-600 font-mono">
            cpu alloc={fmtMilliToCores(detail.cpuAllocMilli)}
            {' '}cap={fmtMilliToCores(detail.cpuCapacityMilli)}
          </div>
          <div class="text-[11px] text-slate-600 font-mono">
            mem alloc={fmtBytes(detail.memAllocBytes)}
            {' '}cap={fmtBytes(detail.memCapacityBytes)}
          </div>
        </div>

        {!detail.metricsAvailable && detail.metricsWarning && (
          <div class="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] text-slate-600">
            {detail.metricsWarning}
          </div>
        )}

        {detail.metricsAvailable && (
          <div class="mt-2 grid gap-2 md:grid-cols-2">
            <div class="text-[11px] text-slate-700 font-mono">
              cpu usage={fmtMilliToCores(detail.cpuUsageMilli)} ({fmtPct(detail.cpuPct)})
            </div>
            <div class="text-[11px] text-slate-700 font-mono">
              mem usage={fmtBytes(detail.memUsageBytes)} ({fmtPct(detail.memPct)})
            </div>
          </div>
        )}
      </div>

      {/* Addresses */}
      <div>
        <h3 class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em] mb-1">
          Addresses
        </h3>
        {addresses.length === 0 ? (
          <div class="text-[11px] text-slate-500">None.</div>
        ) : (
          <div class="space-y-1 text-[11px]">
            {addresses.map((a) => (
              <div key={a} class="font-mono text-slate-700 break-all">
                {a}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Taints */}
      <div>
        <h3 class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em] mb-1">
          Taints
        </h3>
        {taints.length === 0 ? (
          <div class="text-[11px] text-slate-500">No taints.</div>
        ) : (
          <div class="space-y-1 text-[11px]">
            {taints.map((t) => (
              <div key={t} class="font-mono text-slate-700 break-all">
                {t}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Conditions */}
      <div>
        <h3 class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em] mb-1">
          Conditions
        </h3>
        {conditions.length === 0 ? (
          <div class="text-[11px] text-slate-500">None.</div>
        ) : (
          <div class="space-y-2">
            {conditions.map((c) => (
              <div key={c.type} class="rounded-lg border border-slate-200 bg-white px-3 py-2">
                <div class="flex items-center justify-between">
                  <div class="font-mono text-[11px] text-slate-800">{c.type}</div>
                  <div class="font-mono text-[11px] text-slate-600">{c.status}</div>
                </div>
                {(c.reason || c.lastTransitionTime) && (
                  <div class="mt-1 text-[11px] text-slate-500 font-mono">
                    {c.reason ? `reason=${c.reason}` : ''}{c.reason && c.lastTransitionTime ? ' • ' : ''}
                    {c.lastTransitionTime ? `last=${c.lastTransitionTime}` : ''}
                  </div>
                )}
                {c.message && (
                  <div class="mt-1 text-[11px] text-slate-600 break-words">
                    {c.message}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Labels */}
      <div>
        <h3 class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em] mb-1">
          Labels
        </h3>
        <KeyValueList obj={labels} emptyLabel="No labels." />
      </div>
    </div>
  );
}

function KeyValueList({ obj, emptyLabel = 'None.' }) {
  const entries = Object.entries(obj || {});
  if (entries.length === 0) {
    return <div class="text-[11px] text-slate-500">{emptyLabel}</div>;
  }
  // keep it readable: show stable order
  entries.sort((a, b) => a[0].localeCompare(b[0]));
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

function fmtPct(v) {
  if (!v || Number.isNaN(v)) return '0%';
  return `${Math.round(v)}%`;
}

function fmtMilliToCores(m) {
  if (!m) return '-';
  if (m % 1000 === 0) return `${m / 1000}`;
  return `${(m / 1000).toFixed(2)}`;
}

function fmtBytes(b) {
  if (!b) return '-';
  const kb = 1024;
  const mb = kb * 1024;
  const gb = mb * 1024;
  const tb = gb * 1024;
  if (b >= tb) return `${(b / tb).toFixed(2)}Ti`;
  if (b >= gb) return `${(b / gb).toFixed(2)}Gi`;
  if (b >= mb) return `${(b / mb).toFixed(2)}Mi`;
  if (b >= kb) return `${(b / kb).toFixed(2)}Ki`;
  return `${b}B`;
}

function shortOS(os) {
  if (!os) return '-';
  // keep table compact
  if (os.length <= 22) return os;
  return os.slice(0, 22) + '…';
}

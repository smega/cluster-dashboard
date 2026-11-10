import { h } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';

function Pill({ children, tone = 'slate' }) {
  const cls =
    tone === 'emerald'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
      : tone === 'amber'
      ? 'border-amber-200 bg-amber-50 text-amber-800'
      : tone === 'rose'
      ? 'border-rose-200 bg-rose-50 text-rose-700'
      : 'border-slate-200 bg-slate-100 text-slate-600';

  return (
    <span class={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] ${cls}`}>
      {children}
    </span>
  );
}

function fmt(n, digits = 2) {
  if (n === null || n === undefined) return '-';
  if (!isFinite(n)) return '-';
  return Number(n).toFixed(digits);
}

export default function CostWasteSignalsPage({ token }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [labelKeys, setLabelKeys] = useState(() => {
    if (typeof window === 'undefined') return 'team,app,env';
    return localStorage.getItem('waste_labelKeys') || 'team,app,env';
  });

  useEffect(() => {
    if (typeof window !== 'undefined') localStorage.setItem('waste_labelKeys', labelKeys);
  }, [labelKeys]);

  const load = async ({ refresh = false } = {}) => {
    if (!token) return;
    setLoading(true);
    setError('');
    try {
      const qs = new URLSearchParams({
        labelKeys: labelKeys || 'team,app,env',
        refresh: refresh ? 'true' : 'false',
      });
      const res = await fetch(`/api/kube/waste?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || 'Failed to load waste signals');
      setData(j);
    } catch (e) {
      setError(e?.message || 'Failed to load waste signals');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    if (!token) return;
    (async () => {
      if (cancelled) return;
      await load({ refresh: false });
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const nodePools = useMemo(() => Array.isArray(data?.nodePools) ? data.nodePools : [], [data]);
  const unusedPVCs = useMemo(() => (Array.isArray(data?.unusedPVCs) ? data.unusedPVCs : []).slice(0, 30), [data]);
  const idleNS = useMemo(() => (Array.isArray(data?.idleNamespaces) ? data.idleNamespaces : []).slice(0, 30), [data]);
  const failingJobs = useMemo(() => (Array.isArray(data?.failingJobs) ? data.failingJobs : []).slice(0, 30), [data]);

  return (
    <section class="grid gap-4">
      <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 class="text-sm font-semibold text-slate-800">Cost + waste signals</h2>
            <p class="text-xs text-slate-500">
              Node pools: allocatable vs requested vs actual. Unused PVCs, idle namespaces, failing jobs, label-based cost share.
            </p>
            {data?.generatedAt && (
              <p class="mt-1 text-[11px] text-slate-500 font-mono">generated={data.generatedAt}</p>
            )}
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <input
              class="w-64 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 placeholder-slate-400"
              placeholder="Label keys (CSV): team,app,env"
              value={labelKeys}
              onInput={(e) => setLabelKeys(e.currentTarget.value)}
            />
            <button
              class="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              onClick={() => load({ refresh: true })}
              disabled={loading || !token}
            >
              Refresh
            </button>
          </div>
        </div>

        {loading && <div class="mt-3 text-xs text-slate-500 font-mono">loading…</div>}

        {error && !loading && (
          <div class="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {error}
          </div>
        )}

        {data?.warnings?.length ? (
          <div class="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <div class="font-semibold mb-1">Warnings</div>
            <ul class="list-disc pl-5 space-y-1">
              {data.warnings.map((w) => <li key={w} class="font-mono text-[11px]">{w}</li>)}
            </ul>
          </div>
        ) : null}
      </div>

      {/* Top: NodePools + Cost-by-label */}
      <div class="grid gap-4 lg:grid-cols-[2fr,1.3fr]">
        <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div class="flex items-center justify-between mb-3">
            <div>
              <h3 class="text-sm font-semibold text-slate-800">Node pools (waste-ranked)</h3>
              <p class="text-xs text-slate-500">Waste is computed from allocatable − requested and allocatable − actual usage.</p>
            </div>
          </div>

          <div class="overflow-x-auto">
            <table class="min-w-full text-xs border-separate border-spacing-y-[3px]">
              <thead>
                <tr class="text-[11px] text-slate-500">
                  <th class="text-left font-medium px-2 py-1">Pool</th>
                  <th class="text-left font-medium px-2 py-1">Nodes</th>
                  <th class="text-left font-medium px-2 py-1">Alloc (CPU/MemGi)</th>
                  <th class="text-left font-medium px-2 py-1">Req (CPU/MemGi)</th>
                  <th class="text-left font-medium px-2 py-1">Use (CPU/MemGi)</th>
                  <th class="text-left font-medium px-2 py-1">Waste (req)</th>
                  <th class="text-left font-medium px-2 py-1">Waste (use)</th>
                </tr>
              </thead>
              <tbody>
                {nodePools.map((p) => (
                  <tr key={p.name} class="bg-slate-50 hover:bg-slate-100">
                    <td class="px-2 py-1 font-mono text-[11px] text-slate-800">{p.name}</td>
                    <td class="px-2 py-1 font-mono text-[11px] text-slate-600">{p.nodes}</td>
                    <td class="px-2 py-1 font-mono text-[11px] text-slate-700">
                      {fmt(p.allocCpuCores)} / {fmt(p.allocMemGiB)}
                    </td>
                    <td class="px-2 py-1 font-mono text-[11px] text-slate-700">
                      {fmt(p.reqCpuCores)} / {fmt(p.reqMemGiB)}
                    </td>
                    <td class="px-2 py-1 font-mono text-[11px] text-slate-700">
                      {fmt(p.useCpuCores)} / {fmt(p.useMemGiB)}
                    </td>
                    <td class="px-2 py-1 font-mono text-[11px]">
                      <Pill tone={(p.wasteReqCpuCores > 0.5 || p.wasteReqMemGiB > 2) ? 'amber' : 'slate'}>
                        {fmt(p.wasteReqCpuCores)} / {fmt(p.wasteReqMemGiB)}
                      </Pill>
                    </td>
                    <td class="px-2 py-1 font-mono text-[11px]">
                      <Pill tone={(p.wasteUseCpuCores > 0.5 || p.wasteUseMemGiB > 2) ? 'rose' : 'slate'}>
                        {fmt(p.wasteUseCpuCores)} / {fmt(p.wasteUseMemGiB)}
                      </Pill>
                    </td>
                  </tr>
                ))}
                {nodePools.length === 0 && (
                  <tr><td colSpan="7" class="px-2 py-3 text-xs text-slate-500">No node pools returned.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div class="mb-3">
            <h3 class="text-sm font-semibold text-slate-800">Cost by label (rough)</h3>
            <p class="text-xs text-slate-500">
              This is “resource share” based on requested CPU+memory (weight = CPU + MemGi/4).
            </p>
          </div>

          {!data?.costByLabel ? (
            <div class="text-xs text-slate-500">No data.</div>
          ) : (
            <div class="space-y-3">
              {Object.keys(data.costByLabel).map((k) => {
                const items = data.costByLabel[k] || [];
                return (
                  <div key={k} class="rounded-lg border border-slate-200 bg-white px-3 py-2">
                    <div class="flex items-center justify-between">
                      <div class="text-xs font-semibold text-slate-800">{k}</div>
                      <div class="text-[11px] text-slate-500 font-mono">{items.length} shown</div>
                    </div>
                    <div class="mt-2 space-y-1">
                      {items.slice(0, 10).map((it) => (
                        <div key={`${k}:${it.value}`} class="flex items-center justify-between gap-2">
                          <div class="font-mono text-[11px] text-slate-700 truncate max-w-[60%]">{it.value}</div>
                          <div class="font-mono text-[11px] text-slate-500">
                            {fmt(it.pct, 1)}%
                          </div>
                        </div>
                      ))}
                      {items.length === 0 && <div class="text-xs text-slate-500">No values.</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Bottom: PVCs / Jobs / Idle NS */}
      <div class="grid gap-4 lg:grid-cols-3">
        <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <h3 class="text-sm font-semibold text-slate-800 mb-2">Unused PVCs (top by size)</h3>
          <div class="overflow-x-auto">
            <table class="min-w-full text-xs border-separate border-spacing-y-[3px]">
              <thead>
                <tr class="text-[11px] text-slate-500">
                  <th class="text-left font-medium px-2 py-1">NS/Name</th>
                  <th class="text-left font-medium px-2 py-1">SizeGi</th>
                  <th class="text-left font-medium px-2 py-1">Status</th>
                  <th class="text-left font-medium px-2 py-1">Age</th>
                </tr>
              </thead>
              <tbody>
                {unusedPVCs.map((p) => (
                  <tr key={`${p.namespace}/${p.name}`} class="bg-slate-50 hover:bg-slate-100">
                    <td class="px-2 py-1 font-mono text-[11px] text-slate-700">{p.namespace}/{p.name}</td>
                    <td class="px-2 py-1 font-mono text-[11px] text-slate-600">{fmt(p.sizeGiB)}</td>
                    <td class="px-2 py-1"><Pill tone={p.status === 'Bound' ? 'amber' : 'slate'}>{p.status}</Pill></td>
                    <td class="px-2 py-1 font-mono text-[11px] text-slate-500">{p.age}</td>
                  </tr>
                ))}
                {unusedPVCs.length === 0 && (
                  <tr><td colSpan="4" class="px-2 py-3 text-xs text-slate-500">No unused PVCs found.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <h3 class="text-sm font-semibold text-slate-800 mb-2">Jobs failing / retrying</h3>
          <div class="overflow-x-auto">
            <table class="min-w-full text-xs border-separate border-spacing-y-[3px]">
              <thead>
                <tr class="text-[11px] text-slate-500">
                  <th class="text-left font-medium px-2 py-1">NS/Job</th>
                  <th class="text-left font-medium px-2 py-1">A/S/F</th>
                  <th class="text-left font-medium px-2 py-1">Backoff</th>
                  <th class="text-left font-medium px-2 py-1">Age</th>
                </tr>
              </thead>
              <tbody>
                {failingJobs.map((j) => (
                  <tr key={`${j.namespace}/${j.name}`} class="bg-slate-50 hover:bg-slate-100">
                    <td class="px-2 py-1 font-mono text-[11px] text-slate-700">{j.namespace}/{j.name}</td>
                    <td class="px-2 py-1 font-mono text-[11px] text-slate-600">{j.active}/{j.succeeded}/{j.failed}</td>
                    <td class="px-2 py-1">
                      <Pill tone="rose">{j.backoffLimit ?? '-'}</Pill>
                    </td>
                    <td class="px-2 py-1 font-mono text-[11px] text-slate-500">{j.age}</td>
                  </tr>
                ))}
                {failingJobs.length === 0 && (
                  <tr><td colSpan="4" class="px-2 py-3 text-xs text-slate-500">No failing jobs found.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <h3 class="text-sm font-semibold text-slate-800 mb-2">Idle namespaces</h3>
          <p class="text-xs text-slate-500 mb-2">Sorted by fewest active pods (system namespaces hidden).</p>
          <div class="overflow-x-auto">
            <table class="min-w-full text-xs border-separate border-spacing-y-[3px]">
              <thead>
                <tr class="text-[11px] text-slate-500">
                  <th class="text-left font-medium px-2 py-1">Namespace</th>
                  <th class="text-left font-medium px-2 py-1">Pods</th>
                  <th class="text-left font-medium px-2 py-1">Req CPU/MemGi</th>
                </tr>
              </thead>
              <tbody>
                {idleNS.map((n) => (
                  <tr key={n.name} class="bg-slate-50 hover:bg-slate-100">
                    <td class="px-2 py-1 font-mono text-[11px] text-slate-700">{n.name}</td>
                    <td class="px-2 py-1">
                      <Pill tone={n.activePods === 0 ? 'emerald' : 'slate'}>{n.activePods}</Pill>
                    </td>
                    <td class="px-2 py-1 font-mono text-[11px] text-slate-600">
                      {fmt(n.reqCpuCores)} / {fmt(n.reqMemGiB)}
                    </td>
                  </tr>
                ))}
                {idleNS.length === 0 && (
                  <tr><td colSpan="3" class="px-2 py-3 text-xs text-slate-500">No namespaces returned.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  );
}

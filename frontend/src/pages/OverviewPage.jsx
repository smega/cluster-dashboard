// src/pages/OverviewPage.jsx
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { route } from 'preact-router';

export default function OverviewPage({ token, user }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState(null);

  // Toasts (same pattern as other pages)
  const [toasts, setToasts] = useState([]);
  const pushToast = (type, message) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  };

  // Manual refresh tick
  const [tick, setTick] = useState(0);

  const fetchOverview = async (isInitial = false) => {
    if (!token) return;
    if (isInitial) setLoading(true);
    else setRefreshing(true);
    setError('');

    try {
      const res = await fetch('/api/overview', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const text = await res.text();
      if (!res.ok) {
        let msg = text || 'Failed to load overview';
        try {
          const errObj = JSON.parse(text);
          msg = errObj.error || msg;
        } catch {}
        throw new Error(msg);
      }

      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error('Invalid JSON from /api/overview');
      }

      setData(json);
      setLastUpdated(new Date());
    } catch (err) {
      console.error('overview fetch failed', err);
      const msg = err.message || 'Failed to load overview';
      setError(msg);
      pushToast('error', msg);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  // Initial load + manual refresh
  useEffect(() => {
    fetchOverview(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, tick]);

  // Optional auto-refresh every 20s (lightweight; just one endpoint)
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 20000);
    return () => clearInterval(id);
  }, []);

  const stats = data?.stats || {
    namespaces: 0,
    nodes: 0,
    pods: 0,
    deployments: 0,
    crashLoopPods: 0,
    errorPods: 0,
    failingHPAs: 0,
  };

  const unhealthyPods = data?.unhealthyPods || [];
  const problemServices = data?.problemServices || [];
  const problemIngresses = data?.problemIngresses || [];

  const totalProblemPods = (stats.crashLoopPods || 0) + (stats.errorPods || 0);

  const formatTime = (d) => {
    if (!d) return '-';
    try {
      return d.toLocaleTimeString();
    } catch {
      return '-';
    }
  };

  return (
    <>
      <section class="space-y-4">
        {/* Header */}
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 class="text-base font-semibold text-slate-900">
              Cluster overview
            </h1>
            <p class="text-xs text-slate-500">
              Quick health snapshot – pods, services, ingresses and problem spots.
            </p>
          </div>
          <div class="flex items-center gap-2 text-[11px] text-slate-500">
            {refreshing && !loading && (
              <span class="font-mono text-slate-500">updating…</span>
            )}
            {lastUpdated && (
              <span class="font-mono">
                last updated: {formatTime(lastUpdated)}
              </span>
            )}
            <button
              type="button"
              class="rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-100"
              onClick={() => setTick((t) => t + 1)}
            >
              Refresh
            </button>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div class="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {error}
          </div>
        )}

        {/* Loading */}
        {loading && !data && (
          <div class="text-xs text-slate-500 font-mono">
            loading overview…
          </div>
        )}

        {/* Content */}
        {data && (
          <>
            {/* Top stats cards */}
            <div class="grid gap-3 md:grid-cols-4">
              <StatCard label="Namespaces" value={stats.namespaces} />
              <StatCard label="Nodes" value={stats.nodes} />
              <StatCard label="Pods" value={stats.pods} />
              <StatCard label="Deployments" value={stats.deployments} />
            </div>

            {/* Health summary cards */}
            <div class="grid gap-3 md:grid-cols-3">
              <ClickableStatCard
                label="CrashLoopBackOff pods"
                value={stats.crashLoopPods}
                tone="rose"
                onClick={
                  stats.crashLoopPods > 0
                    ? () => route('/pods?problem=1')
                    : null
                }
                hint="Click to see problematic pods"
              />
              <ClickableStatCard
                label="Error / failed pods"
                value={stats.errorPods}
                tone="amber"
                onClick={
                  stats.errorPods > 0
                    ? () => route('/pods?problem=1')
                    : null
                }
                hint="Includes ImagePull / Failed / BackOff"
              />
              <ClickableStatCard
                label="Failing HPAs"
                value={stats.failingHPAs}
                tone="slate"
                onClick={
                  stats.failingHPAs > 0
                    ? () => route('/hpa')
                    : null
                }
                hint="Hook up once HPA tab exists"
              />
            </div>

            {/* Tables row */}
            <div class="grid gap-4 lg:grid-cols-2">
              {/* Unhealthy pods */}
              <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <div class="flex items-center justify-between mb-2">
                  <div>
                    <h2 class="text-sm font-semibold text-slate-800">
                      Unhealthy pods
                    </h2>
                    <p class="text-xs text-slate-500">
                      CrashLoop / failing pods across all namespaces.
                    </p>
                  </div>
                  <div class="flex items-center gap-2 text-[11px] text-slate-500 font-mono">
                    <span>count={unhealthyPods.length}</span>
                    {totalProblemPods > 0 && (
                      <button
                        type="button"
                        class="rounded-full border border-slate-300 bg-white px-2 py-0.5 hover:bg-slate-100"
                        onClick={() => route('/pods?problem=1')}
                      >
                        open pods
                      </button>
                    )}
                  </div>
                </div>

                {unhealthyPods.length === 0 ? (
                  <div class="text-xs text-emerald-700">
                    No unhealthy pods detected 🎉
                  </div>
                ) : (
                  <div class="overflow-x-auto">
                    <table class="min-w-full text-xs border-separate border-spacing-y-[3px]">
                      <thead>
                        <tr class="text-[11px] text-slate-500">
                          <th class="text-left font-medium px-2 py-1">
                            Namespace
                          </th>
                          <th class="text-left font-medium px-2 py-1">
                            Pod
                          </th>
                          <th class="text-left font-medium px-2 py-1">
                            Reason
                          </th>
                          <th class="text-left font-medium px-2 py-1">
                            Restarts
                          </th>
                          {/* NEW */}
                          <th class="text-left font-medium px-2 py-1">
                            Actions
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {unhealthyPods.map((p) => {
                          const ns = p.namespace || '';
                          const pod = p.name || '';
                          return (
                            <tr
                              key={`${p.namespace}-${p.name}-${p.reason}`}
                              class="bg-slate-50 hover:bg-slate-100"
                            >
                              <td class="px-2 py-1 align-top text-[11px] text-slate-600 font-mono">
                                {ns}
                              </td>
                              <td class="px-2 py-1 align-top text-[11px] text-slate-800 font-mono">
                                {pod}
                              </td>
                              <td class="px-2 py-1 align-top text-[11px] text-rose-700 font-mono">
                                {p.reason}
                              </td>
                              <td class="px-2 py-1 align-top text-[11px] text-slate-800 font-mono">
                                {p.restarts}
                              </td>

                              {/* NEW */}
                              <td class="px-2 py-1 align-top">
                                <div class="flex flex-wrap gap-2">
                                  <button
                                    type="button"
                                    class="rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-100"
                                    onClick={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      route(
                                        `/pods?ns=${encodeURIComponent(ns)}&q=${encodeURIComponent(
                                          pod
                                        )}`
                                      );
                                    }}
                                    title="Open Pods page filtered to this pod"
                                  >
                                    View
                                  </button>

                                  <button
                                    type="button"
                                    class="rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-100"
                                    onClick={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      route(
                                        `/logs?ns=${encodeURIComponent(ns)}&pod=${encodeURIComponent(
                                          pod
                                        )}`
                                      );
                                    }}
                                    title="Open Logs page for this pod"
                                  >
                                    Logs
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Problem services & ingresses */}
              <div class="space-y-4">
                {/* Problem services */}
                <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div class="flex items-center justify-between mb-2">
                    <div>
                      <h2 class="text-sm font-semibold text-slate-800">
                        Problem services
                      </h2>
                      <p class="text-xs text-slate-500">
                        Services with selectors but no endpoints.
                      </p>
                    </div>
                    <div class="flex items-center gap-2 text-[11px] text-slate-500 font-mono">
                      <span>count={problemServices.length}</span>
                      {problemServices.length > 0 && (
                        <button
                          type="button"
                          class="rounded-full border border-slate-300 bg-white px-2 py-0.5 hover:bg-slate-100"
                          onClick={() => route('/services?problem=orphan')}
                        >
                          open services
                        </button>
                      )}
                    </div>
                  </div>

                  {problemServices.length === 0 ? (
                    <div class="text-xs text-emerald-700">
                      No orphan services detected.
                    </div>
                  ) : (
                    <div class="overflow-x-auto">
                      <table class="min-w-full text-xs border-separate border-spacing-y-[3px]">
                        <thead>
                          <tr class="text-[11px] text-slate-500">
                            <th class="text-left font-medium px-2 py-1">
                              Namespace
                            </th>
                            <th class="text-left font-medium px-2 py-1">
                              Service
                            </th>
                            <th class="text-left font-medium px-2 py-1">
                              Type
                            </th>
                            <th class="text-left font-medium px-2 py-1">
                              Reason
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {problemServices.map((s) => (
                            <tr
                              key={`${s.namespace}-${s.name}`}
                              class="bg-slate-50 hover:bg-slate-100"
                            >
                              <td class="px-2 py-1 align-top text-[11px] text-slate-600 font-mono">
                                {s.namespace}
                              </td>
                              <td class="px-2 py-1 align-top text-[11px] text-slate-800 font-mono">
                                {s.name}
                              </td>
                              <td class="px-2 py-1 align-top text-[11px] text-slate-600 font-mono">
                                {s.type}
                              </td>
                              <td class="px-2 py-1 align-top text-[11px] text-rose-700 font-mono">
                                {s.reason}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* Problem ingresses */}
                <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div class="flex items-center justify-between mb-2">
                    <div>
                      <h2 class="text-sm font-semibold text-slate-800">
                        Problem ingresses
                      </h2>
                      <p class="text-xs text-slate-500">
                        Rules pointing to missing services.
                      </p>
                    </div>
                    <div class="flex items-center gap-2 text-[11px] text-slate-500 font-mono">
                      <span>count={problemIngresses.length}</span>
                      {problemIngresses.length > 0 && (
                        <button
                          type="button"
                          class="rounded-full border border-slate-300 bg-white px-2 py-0.5 hover:bg-slate-100"
                          onClick={() => route('/ingresses?problem=broken')}
                        >
                          open ingresses
                        </button>
                      )}
                    </div>
                  </div>

                  {problemIngresses.length === 0 ? (
                    <div class="text-xs text-emerald-700">
                      No broken ingress backends detected.
                    </div>
                  ) : (
                    <div class="overflow-x-auto">
                      <table class="min-w-full text-xs border-separate border-spacing-y-[3px]">
                        <thead>
                          <tr class="text-[11px] text-slate-500">
                            <th class="text-left font-medium px-2 py-1">
                              Namespace
                            </th>
                            <th class="text-left font-medium px-2 py-1">
                              Ingress
                            </th>
                            <th class="text-left font-medium px-2 py-1">
                              Host
                            </th>
                            <th class="text-left font-medium px-2 py-1">
                              Path
                            </th>
                            <th class="text-left font-medium px-2 py-1">
                              Service
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {problemIngresses.map((ing, idx) => (
                            <tr
                              key={`${ing.namespace}-${ing.name}-${idx}`}
                              class="bg-slate-50 hover:bg-slate-100"
                            >
                              <td class="px-2 py-1 align-top text-[11px] text-slate-600 font-mono">
                                {ing.namespace}
                              </td>
                              <td class="px-2 py-1 align-top text-[11px] text-slate-800 font-mono">
                                {ing.name}
                              </td>
                              <td class="px-2 py-1 align-top text-[11px] text-slate-600 font-mono">
                                {ing.host || '-'}
                              </td>
                              <td class="px-2 py-1 align-top text-[11px] text-slate-600 font-mono">
                                {ing.path}
                              </td>
                              <td class="px-2 py-1 align-top text-[11px] text-rose-700 font-mono">
                                {ing.serviceName}
                                {ing.servicePort && `:${ing.servicePort}`}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
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

function StatCard({ label, value }) {
  return (
    <div class="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
      <div class="text-[11px] text-slate-500 mb-1">{label}</div>
      <div class="text-xl font-semibold text-slate-900 font-mono">
        {value}
      </div>
    </div>
  );
}

function ClickableStatCard({ label, value, tone = 'slate', onClick, hint }) {
  const clickable = typeof onClick === 'function' && value > 0;
  const base =
    'rounded-2xl border p-3 shadow-sm transition cursor-default ' +
    (clickable ? 'hover:-translate-y-[1px]' : '');

  let toneClasses = 'border-slate-200 bg-slate-50';
  if (tone === 'rose') {
    toneClasses = 'border-rose-200 bg-rose-50';
  } else if (tone === 'amber') {
    toneClasses = 'border-amber-200 bg-amber-50';
  }

  const content = (
    <div class={base + ' ' + toneClasses}>
      <div class="flex items-center justify-between mb-1">
        <div class="text-[11px] text-slate-600">{label}</div>
        {hint && (
          <div class="text-[10px] text-slate-400 font-mono">
            {hint}
          </div>
        )}
      </div>
      <div class="text-xl font-semibold text-slate-900 font-mono">
        {value}
      </div>
    </div>
  );

  if (!clickable) return content;

  return (
    <button
      type="button"
      class="text-left"
      onClick={onClick}
    >
      {content}
    </button>
  );
}

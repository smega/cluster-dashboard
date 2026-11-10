import { h } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';

export default function JobsPage({ token, user }) {
  const [namespaces, setNamespaces] = useState([]);

  const [namespaceFilter, setNamespaceFilter] = useState(() => {
    if (typeof window === 'undefined') return 'all';
    return localStorage.getItem('jobs_ns') || 'all';
  });

  const [typeFilter, setTypeFilter] = useState(() => {
    if (typeof window === 'undefined') return 'all';
    return localStorage.getItem('jobs_type') || 'all'; // all | cronjob | job
  });

  const [search, setSearch] = useState('');

  const [cronjobs, setCronjobs] = useState([]);
  const [jobs, setJobs] = useState([]);

  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');
  const [reloadTick, setReloadTick] = useState(0);

  const [selected, setSelected] = useState(null); // { type, namespace, name }
  const [detail, setDetail] = useState(null);     // { kind, namespace, name, object }

  const [toasts, setToasts] = useState([]);

  const isAdmin = (user?.role || '').toLowerCase() === 'admin';

  const pushToast = (type, message) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  };

  // Persist filters
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('jobs_ns', namespaceFilter);
    }
  }, [namespaceFilter]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('jobs_type', typeFilter);
    }
  }, [typeFilter]);

  // Load namespaces once
  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    const loadNamespaces = async () => {
      try {
        const res = await fetch('/api/kube/namespaces', {
          headers: { Authorization: `Bearer ${token}` }
        });
        const text = await res.text();
        if (!res.ok) {
          let msg = text || 'Failed to load namespaces';
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
          throw new Error('Invalid JSON from /api/kube/namespaces');
        }

        if (cancelled) return;

        const items = Array.isArray(data.items) ? data.items : [];
        const ns = items.map((x) => x?.name).filter(Boolean).sort();
        setNamespaces(ns);

        // If current ns is invalid, pick default
        if (namespaceFilter !== 'all' && ns.length > 0 && !ns.includes(namespaceFilter)) {
          setNamespaceFilter('all');
        }
      } catch (err) {
        console.error('namespaces fetch failed', err);
        const msg = err.message || 'Failed to load namespaces';
        if (!cancelled) {
          setNamespaces([]);
          pushToast('error', msg);
        }
      }
    };

    loadNamespaces();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Load batch list (jobs + cronjobs)
  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const qs = namespaceFilter ? `?namespace=${encodeURIComponent(namespaceFilter)}` : '';
        const res = await fetch(`/api/kube/batch${qs}`, {
          headers: { Authorization: `Bearer ${token}` }
        });

        const text = await res.text();
        if (!res.ok) {
          let msg = text || 'Failed to load jobs';
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
          throw new Error('Invalid JSON from /api/kube/batch');
        }

        if (cancelled) return;

        const cj = Array.isArray(data.cronjobs) ? data.cronjobs : [];
        const jb = Array.isArray(data.jobs) ? data.jobs : [];

        setCronjobs(cj);
        setJobs(jb);

        // Keep selection if still exists in current list
        if (selected) {
          const exists =
            (selected.type === 'CronJob' &&
              cj.some((x) => x.name === selected.name && x.namespace === selected.namespace)) ||
            (selected.type === 'Job' &&
              jb.some((x) => x.name === selected.name && x.namespace === selected.namespace));

          if (!exists) {
            setSelected(null);
            setDetail(null);
          }
        }
      } catch (err) {
        console.error('batch fetch failed', err);
        const msg = err.message || 'Failed to load jobs';
        if (!cancelled) {
          setError(msg);
          setCronjobs([]);
          setJobs([]);
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

  // Load detail when selection changes
  useEffect(() => {
    if (!token) return;
    if (!selected) return;

    let cancelled = false;

    const loadDetail = async () => {
      setDetailLoading(true);
      setError('');
      try {
        const ns = selected.namespace;
        const name = selected.name;

        const path =
          selected.type === 'CronJob'
            ? `/api/kube/cronjobs/${encodeURIComponent(ns)}/${encodeURIComponent(name)}`
            : `/api/kube/jobs/${encodeURIComponent(ns)}/${encodeURIComponent(name)}`;

        const res = await fetch(path, {
          headers: { Authorization: `Bearer ${token}` }
        });

        const text = await res.text();
        if (!res.ok) {
          let msg = text || 'Failed to load details';
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
          throw new Error('Invalid JSON from detail endpoint');
        }

        if (cancelled) return;

        setDetail(data);
      } catch (err) {
        console.error('detail fetch failed', err);
        const msg = err.message || 'Failed to load details';
        if (!cancelled) {
          setDetail(null);
          setError(msg);
          pushToast('error', msg);
        }
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    };

    loadDetail();
    return () => {
      cancelled = true;
    };
  }, [token, selected]);

  const rows = useMemo(() => {
    const cjRows = cronjobs.map((x) => ({
      type: 'CronJob',
      name: x.name,
      namespace: x.namespace,
      primary: x.schedule || '-',
      status: cronJobStatus(x),
      meta: [
        x.concurrencyPolicy ? `concurrency=${x.concurrencyPolicy}` : null,
        typeof x.suspend === 'boolean' ? `suspend=${x.suspend}` : null,
        typeof x.active === 'number' ? `active=${x.active}` : null,
        x.lastScheduleTime ? `last=${shortTime(x.lastScheduleTime)}` : null
      ].filter(Boolean).join(' · '),
      age: x.age || '-',
      raw: x
    }));

    const jobRows = jobs.map((x) => ({
      type: 'Job',
      name: x.name,
      namespace: x.namespace,
      primary:
        x.completions != null
          ? `${x.succeeded || 0}/${x.completions}`
          : `${x.succeeded || 0} succeeded`,
      status: jobStatus(x),
      meta: [
        x.owner ? `owner=${x.owner}` : null,
        `a=${x.active || 0}`,
        `s=${x.succeeded || 0}`,
        `f=${x.failed || 0}`,
        x.startTime ? `start=${shortTime(x.startTime)}` : null,
        x.completionTime ? `done=${shortTime(x.completionTime)}` : null
      ].filter(Boolean).join(' · '),
      age: x.age || '-',
      raw: x
    }));

    return [...cjRows, ...jobRows].sort((a, b) => {
      if (a.namespace === b.namespace) {
        if (a.type === b.type) return a.name.localeCompare(b.name);
        return a.type.localeCompare(b.type);
      }
      return a.namespace.localeCompare(b.namespace);
    });
  }, [cronjobs, jobs]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (typeFilter === 'cronjob' && r.type !== 'CronJob') return false;
      if (typeFilter === 'job' && r.type !== 'Job') return false;
      if (!q) return true;

      const text = `${r.namespace}/${r.name} ${r.type} ${r.primary} ${r.status}`.toLowerCase();
      return text.includes(q);
    });
  }, [rows, search, typeFilter]);

  const selectedSummaryItem = useMemo(() => {
    if (!selected) return null;
    if (selected.type === 'CronJob') {
      return cronjobs.find((x) => x.name === selected.name && x.namespace === selected.namespace) || null;
    }
    return jobs.find((x) => x.name === selected.name && x.namespace === selected.namespace) || null;
  }, [selected, cronjobs, jobs]);

  return (
    <>
      <section class="grid gap-4 lg:grid-cols-[2fr,1.3fr]">
        {/* Left: list */}
        <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div class="flex flex-wrap items-center justify-between gap-3 mb-3">
            <div>
              <h2 class="text-sm font-semibold text-slate-800">Jobs</h2>
              <p class="text-xs text-slate-500">
                CronJobs and Jobs in the cluster (select namespace).
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

              <select
                class="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700"
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
              >
                <option value="all">All types</option>
                <option value="cronjob">CronJobs</option>
                <option value="job">Jobs</option>
              </select>

              <input
                type="text"
                placeholder="Search name / ns…"
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
              <span>loading jobs…</span>
            ) : (
              <span>
                {filtered.length} shown / {rows.length} total
              </span>
            )}
            <span class="text-[11px] text-slate-400">
              mode={isAdmin ? '"admin"' : '"readonly"'}
            </span>
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
                    <th class="text-left font-medium px-2 py-1">Name</th>
                    <th class="text-left font-medium px-2 py-1">Namespace</th>
                    <th class="text-left font-medium px-2 py-1">Schedule / Completions</th>
                    <th class="text-left font-medium px-2 py-1">Status</th>
                    <th class="text-left font-medium px-2 py-1">Age</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => (
                    <tr
                      key={`${r.type}-${r.namespace}-${r.name}`}
                      class={
                        'cursor-pointer bg-slate-50 hover:bg-slate-100 ' +
                        (selected &&
                        selected.type === r.type &&
                        selected.namespace === r.namespace &&
                        selected.name === r.name
                          ? 'outline outline-1 outline-emerald-400/70'
                          : '')
                      }
                      onClick={() => {
                        setSelected({ type: r.type, namespace: r.namespace, name: r.name });
                        setDetail(null);
                      }}
                    >
                      <td class="px-2 py-1 align-top">
                        <TypeBadge type={r.type} />
                      </td>
                      <td class="px-2 py-1 align-top">
                        <div class="font-mono text-[11px] text-slate-800">{r.name}</div>
                        {r.meta ? (
                          <div class="text-[11px] text-slate-500 font-mono">{r.meta}</div>
                        ) : null}
                      </td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-600 font-mono">
                        {r.namespace}
                      </td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-700 font-mono">
                        {r.primary}
                      </td>
                      <td class="px-2 py-1 align-top text-[11px]">
                        <StatusBadge type={r.type} status={r.status} />
                      </td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-600 font-mono">
                        {r.age}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {filtered.length === 0 && (
                <div class="mt-3 text-xs text-slate-500">
                  No jobs match the current filters.
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right: details */}
        <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div class="flex items-center justify-between mb-3">
            <div>
              <h2 class="text-sm font-semibold text-slate-800">Job details</h2>
              <p class="text-xs text-slate-500">
                Summary, labels/annotations and raw Kubernetes object.
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
              No job selected. Click a row on the left to see details.
            </div>
          )}

          {selected && (
            <JobDetailPanel
              selected={selected}
              summary={selectedSummaryItem}
              detail={detail}
              detailLoading={detailLoading}
            />
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

function TypeBadge({ type }) {
  const cls =
    type === 'CronJob'
      ? 'bg-indigo-50 text-indigo-700 border-indigo-200'
      : 'bg-slate-100 text-slate-700 border-slate-200';

  return (
    <span class={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-mono ${cls}`}>
      {type}
    </span>
  );
}

function StatusBadge({ type, status }) {
  const s = (status || '').toLowerCase();

  let cls = 'bg-slate-100 text-slate-700 border-slate-200';

  if (type === 'CronJob') {
    if (s.includes('suspend')) cls = 'bg-amber-50 text-amber-700 border-amber-200';
    else cls = 'bg-emerald-50 text-emerald-700 border-emerald-200';
  } else {
    if (s === 'running') cls = 'bg-indigo-50 text-indigo-700 border-indigo-200';
    else if (s === 'complete') cls = 'bg-emerald-50 text-emerald-700 border-emerald-200';
    else if (s === 'failed') cls = 'bg-rose-50 text-rose-700 border-rose-200';
    else cls = 'bg-slate-100 text-slate-700 border-slate-200';
  }

  return (
    <span class={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-mono ${cls}`}>
      {status || 'Unknown'}
    </span>
  );
}

function JobDetailPanel({ selected, summary, detail, detailLoading }) {
  const kind = selected?.type || detail?.kind || '-';

  const labels =
    detail?.object?.metadata?.labels ||
    summary?.labels ||
    {};

  const annotations =
    detail?.object?.metadata?.annotations ||
    summary?.annotations ||
    {};

  return (
    <div class="space-y-4 text-xs">
      {/* Summary */}
      <div class="flex flex-wrap items-center gap-3">
        <TypeBadge type={selected.type} />
        <StatusBadge type={selected.type} status={selected.type === 'CronJob' ? cronJobStatus(summary) : jobStatus(summary)} />
        {summary?.age ? (
          <span class="font-mono text-slate-600">age={summary.age}</span>
        ) : (
          <span class="font-mono text-slate-600">age=-</span>
        )}
        {selected.type === 'CronJob' && summary?.schedule ? (
          <span class="font-mono text-slate-600">schedule={summary.schedule}</span>
        ) : null}
        {selected.type === 'Job' && summary?.owner ? (
          <span class="font-mono text-slate-600">owner={summary.owner}</span>
        ) : null}
      </div>

      {/* Kind-specific box */}
      <div class="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 flex flex-col gap-1">
        <div class="flex items-center justify-between">
          <div class="text-[11px] text-slate-600 font-mono">kind={kind}</div>
          {selected.type === 'CronJob' && typeof summary?.active === 'number' ? (
            <div class="text-[11px] text-slate-600 font-mono">active={summary.active}</div>
          ) : null}
        </div>

        {selected.type === 'CronJob' ? (
          <>
            <div class="text-[11px] text-slate-600 font-mono">
              suspend={typeof summary?.suspend === 'boolean' ? String(summary.suspend) : '-'}
            </div>
            <div class="text-[11px] text-slate-600 font-mono">
              concurrency={summary?.concurrencyPolicy || '-'}
            </div>
            <div class="text-[11px] text-slate-600 font-mono">
              lastSchedule={summary?.lastScheduleTime ? shortTime(summary.lastScheduleTime) : '-'}
            </div>
          </>
        ) : (
          <>
            <div class="text-[11px] text-slate-600 font-mono">
              a={summary?.active ?? 0} s={summary?.succeeded ?? 0} f={summary?.failed ?? 0}
            </div>
            <div class="text-[11px] text-slate-600 font-mono">
              completions={summary?.completions ?? '-'} parallelism={summary?.parallelism ?? '-'}
            </div>
            <div class="text-[11px] text-slate-600 font-mono">
              start={summary?.startTime ? shortTime(summary.startTime) : '-'} done={summary?.completionTime ? shortTime(summary.completionTime) : '-'}
            </div>
          </>
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

      {/* Raw object */}
      <div>
        <h3 class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em] mb-1">
          Raw object
        </h3>

        {detailLoading ? (
          <div class="text-[11px] text-slate-500 font-mono">loading details…</div>
        ) : !detail?.object ? (
          <div class="text-[11px] text-slate-500">
            No detail loaded yet (select a row again if needed).
          </div>
        ) : (
          <pre class="text-[11px] bg-white border border-slate-200 rounded-xl p-3 overflow-auto max-h-[55vh] font-mono text-slate-800">
{JSON.stringify(detail.object, null, 2)}
          </pre>
        )}
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

function cronJobStatus(cj) {
  if (!cj) return 'Unknown';
  if (cj.suspend === true) return 'Suspended';
  return 'Active';
}

function jobStatus(j) {
  if (!j) return 'Unknown';
  if ((j.failed || 0) > 0) return 'Failed';
  if ((j.active || 0) > 0) return 'Running';
  if (j.completionTime) return 'Complete';
  return 'Idle';
}

function shortTime(s) {
  try {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return String(s);
    // Keep it compact like other pages
    return d.toISOString().replace('.000Z', 'Z');
  } catch {
    return String(s);
  }
}

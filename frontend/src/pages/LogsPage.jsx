import { h } from 'preact';
import { useState, useEffect, useMemo, useRef } from 'preact/hooks';
import { EventSourcePolyfill } from 'event-source-polyfill';

export default function LogsPage({ token, user }) {
  const [pods, setPods] = useState([]);
  const [namespaces, setNamespaces] = useState([]);

  const [namespaceFilter, setNamespaceFilter] = useState('');
  const [podName, setPodName] = useState('');
  const [containerNames, setContainerNames] = useState([]);
  const [containerName, setContainerName] = useState('');

  const [loadingPods, setLoadingPods] = useState(true);
  const [podsError, setPodsError] = useState('');

  const [logsText, setLogsText] = useState('');
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState('');

  const [liveEnabled, setLiveEnabled] = useState(false);
  const [liveState, setLiveState] = useState('off'); // off | connecting | open | closed

  const logBoxRef = useRef(null);
  const liveRef = useRef(null);

  const isAdmin = (user?.role || '').toLowerCase() === 'admin';

  // Toasts (bottom-right)
  const [toasts, setToasts] = useState([]);
  const pushToast = (type, message) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  };

  // --- Initial state from URL + localStorage ---------------------------------
  const [initialised, setInitialised] = useState(false);

  useEffect(() => {
    if (initialised) return;
    if (typeof window === 'undefined') return;

    const params = new URLSearchParams(window.location.search);
    const qpNs = params.get('ns') || params.get('namespace');
    const qpPod = params.get('pod');
    const qpContainer = params.get('container');

    let ns = qpNs;
    if (!ns) {
      try {
        ns = localStorage.getItem('logs_ns') || '';
      } catch {
        ns = '';
      }
    }
    if (ns) setNamespaceFilter(ns);

    if (qpPod) setPodName(qpPod);
    if (qpContainer) setContainerName(qpContainer);

    setInitialised(true);
  }, [initialised]);

  // Remember namespace
  useEffect(() => {
    if (typeof window !== 'undefined' && namespaceFilter) {
      try {
        localStorage.setItem('logs_ns', namespaceFilter);
      } catch {}
    }
  }, [namespaceFilter]);

  // --- Load pods list ---------------------------------------------------------
  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    const load = async () => {
      setLoadingPods(true);
      setPodsError('');
      try {
        const res = await fetch('/api/pods', {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) {
          const txt = await res.text();
          throw new Error(txt || 'Failed to load pods list');
        }
        const data = await res.json();
        if (cancelled) return;

        const items = Array.isArray(data.items) ? data.items : [];
        const nss = Array.isArray(data.namespaces)
          ? data.namespaces
          : Array.from(new Set(items.map((p) => p.namespace)));

        setPods(items);
        setNamespaces(nss.sort());
      } catch (err) {
        console.error('pods list for logs failed', err);
        if (!cancelled) {
          const msg = err.message || 'Failed to load pods list';
          setPodsError(msg);
          pushToast('error', msg);
        }
      } finally {
        if (!cancelled) setLoadingPods(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // --- Derived: pods in current namespace ------------------------------------
  const podsInNamespace = useMemo(() => {
    if (!namespaceFilter) return [];
    return pods.filter((p) => p.namespace === namespaceFilter);
  }, [pods, namespaceFilter]);

  // --- Validate pod when namespace/pods change -------------------------------
  useEffect(() => {
    if (loadingPods) return;

    if (!namespaceFilter) {
      setPodName('');
      setContainerNames([]);
      setContainerName('');
      setLogsText('');
      setLogsError('');
      return;
    }

    if (!podName) return;

    const exists = pods.some(
      (p) => p.namespace === namespaceFilter && p.name === podName
    );
    if (!exists) {
      setPodName('');
      setContainerNames([]);
      setContainerName('');
      setLogsText('');
      setLogsError('');
    }
  }, [namespaceFilter, pods, loadingPods, podName]);

  // --- Auto-select single pod in ns (if none selected) -----------------------
  useEffect(() => {
    if (loadingPods) return;
    if (!namespaceFilter) return;
    if (podName) return;

    if (podsInNamespace.length === 1) {
      setPodName(podsInNamespace[0].name);
    }
  }, [namespaceFilter, podsInNamespace, loadingPods, podName]);

  // --- When pod changes: fetch pod detail to get containers ------------------
  useEffect(() => {
    if (!token || !namespaceFilter || !podName) {
      setContainerNames([]);
      setContainerName('');
      setLogsText('');
      setLogsError('');
      return;
    }

    let cancelled = false;

    const loadDetail = async () => {
      setContainerNames([]);
      setContainerName('');
      setLogsText('');
      setLogsError('');

      try {
        const res = await fetch(
          `/api/pods/${encodeURIComponent(
            namespaceFilter
          )}/${encodeURIComponent(podName)}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!res.ok) {
          const txt = await res.text();
          throw new Error(txt || 'Failed to load pod detail');
        }
        const data = await res.json();
        if (cancelled) return;

        const containers = (data.containers || [])
          .map((c) => c.name)
          .filter(Boolean);

        setContainerNames(containers);

        if (containers.length === 1) {
          setContainerName(containers[0]);
        } else if (containers.length > 1) {
          setContainerName((prev) =>
            prev && containers.includes(prev) ? prev : containers[0]
          );
        } else {
          setContainerName('');
        }
      } catch (err) {
        console.error('pod detail for logs failed', err);
        if (!cancelled) {
          const msg = err.message || 'Failed to load pod detail';
          setLogsError(msg);
          pushToast('error', msg);
        }
      }
    };

    loadDetail();
    return () => {
      cancelled = true;
    };
  }, [token, namespaceFilter, podName]);

  // --- Fetch static logs whenever containerName is set -----------------------
  useEffect(() => {
    if (!token || !namespaceFilter || !podName || !containerName) {
      setLogsLoading(false);
      return;
    }

    let cancelled = false;

    const loadLogs = async () => {
      setLogsLoading(true);
      setLogsError('');
      try {
        const params = new URLSearchParams({
          namespace: namespaceFilter,
          pod: podName,
          container: containerName,
          tailLines: '300'
        });
        const res = await fetch(`/api/logs?${params.toString()}`, {
          headers: { Authorization: `Bearer ${token}` }
        });

        const text = await res.text();

        if (!res.ok) {
          throw new Error(text || 'Failed to load logs');
        }

        if (cancelled) return;

        let data;
        try {
          data = JSON.parse(text);
        } catch {
          data = { logs: text };
        }

        const logs = data.logs || '';
        const reversed = logs
          .split('\n')
          .filter((line) => line.length > 0)
          .reverse()
          .join('\n');

        setLogsText(reversed);
      } catch (err) {
        console.error('logs fetch failed', err);
        if (!cancelled) {
          const msg = err.message || 'Failed to load logs';
          setLogsError(msg);
          pushToast('error', msg);
        }
      } finally {
        if (!cancelled) setLogsLoading(false);
      }
    };

    loadLogs();
    return () => {
      cancelled = true;
    };
  }, [token, namespaceFilter, podName, containerName]);

  // --- Live SSE logs (optional) ----------------------------------------------
  useEffect(() => {
    if (
      !liveEnabled ||
      !token ||
      !namespaceFilter ||
      !podName ||
      !containerName
    ) {
      if (liveRef.current) {
        liveRef.current.close();
        liveRef.current = null;
      }
      setLiveState('off');
      return;
    }

    const params = new URLSearchParams({
      namespace: namespaceFilter,
      pod: podName,
      container: containerName
    });

    const es = new EventSourcePolyfill(
      `/api/logs/stream?${params.toString()}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        heartbeatTimeout: 60000
      }
    );

    liveRef.current = es;
    setLiveState('connecting');

    es.onopen = () => {
      setLiveState('open');
    };

    es.onerror = (err) => {
      console.warn('logs stream error', err);
      setLiveState('connecting');
    };

    es.addEventListener('log', (evt) => {
      try {
        const payload = JSON.parse(evt.data);
        const line = payload.line ?? '';
        // NEWEST FIRST: prepend
        setLogsText((prev) => (prev ? line + '\n' + prev : line));
      } catch (e) {
        console.error('bad log event', e);
      }
    });

    return () => {
      setLiveState('closed');
      if (liveRef.current === es) {
        es.close();
        liveRef.current = null;
      } else {
        es.close();
      }
    };
  }, [liveEnabled, token, namespaceFilter, podName, containerName]);

  // Auto-scroll logs to top (newest first)
  useEffect(() => {
    if (logBoxRef.current) {
      logBoxRef.current.scrollTop = 0;
    }
  }, [logsText]);

  const podsOptions = podsInNamespace;

  return (
    <>
      <section class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm flex flex-col gap-4">
        {/* Header */}
        <div class="flex items-center justify-between">
          <div>
            <h2 class="text-sm font-semibold text-slate-800">Logs</h2>
            <p class="text-xs text-slate-500">
              Pick namespace, pod and container. Newest logs appear at the top. Live streaming is optional.
            </p>
          </div>
          {logsLoading && (
            <div class="text-[11px] text-slate-500 font-mono">
              loading logs…
            </div>
          )}
        </div>

        {/* Top controls */}
        <div class="grid gap-3 md:grid-cols-3 text-xs">
          {/* Namespace */}
          <div class="flex flex-col gap-1">
            <label class="text-[11px] font-medium text-slate-700">
              Namespace
            </label>
            <select
              class="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700"
              value={namespaceFilter}
              onChange={(e) => {
                setNamespaceFilter(e.target.value);
                setPodName('');
                setContainerNames([]);
                setContainerName('');
                setLogsText('');
                setLogsError('');
              }}
            >
              <option value="">Select namespace…</option>
              {namespaces.map((ns) => (
                <option key={ns} value={ns}>
                  {ns}
                </option>
              ))}
            </select>
          </div>

          {/* Pod */}
          <div class="flex flex-col gap-1">
            <label class="text-[11px] font-medium text-slate-700">
              Pod
            </label>
            <select
              class="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700"
              value={podName}
              onChange={(e) => {
                const nextPod = e.target.value;
                setPodName(nextPod);
                setContainerNames([]);
                setContainerName('');
                setLogsText('');
                setLogsError('');
              }}
              disabled={!namespaceFilter || podsOptions.length === 0}
            >
              <option value="">Select pod…</option>
              {podsOptions.map((p) => (
                <option key={`${p.namespace}-${p.name}`} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          {/* Container / Live / Refresh */}
          <div class="flex flex-col gap-2">
            {containerNames.length > 1 && (
              <div class="flex flex-col gap-1">
                <label class="text-[11px] font-medium text-slate-700">
                  Container
                </label>
                <select
                  class="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700"
                  value={containerName}
                  onChange={(e) => setContainerName(e.target.value)}
                  disabled={!podName}
                >
                  {containerNames.map((cn) => (
                    <option key={cn} value={cn}>
                      {cn}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {containerNames.length === 1 && (
              <div class="text-[11px] text-slate-500 font-mono">
                container={containerNames[0]}
              </div>
            )}

            <div class="flex items-center justify-between gap-2">
              <label class="inline-flex items-center gap-1 cursor-pointer text-[11px] text-slate-600">
                <input
                  type="checkbox"
                  checked={liveEnabled}
                  onChange={(e) => {
                    const enabled = e.target.checked;
                    setLiveEnabled(enabled);
                    if (enabled) {
                      pushToast('info', 'Live logs enabled');
                    } else {
                      pushToast('info', 'Live logs disabled');
                    }
                  }}
                />
                <span>Live follow</span>
              </label>
              <button
                type="button"
                class="rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-100"
                onClick={() => {
                  if (namespaceFilter && podName && containerName) {
                    const current = containerName;
                    setContainerName('');
                    setTimeout(() => setContainerName(current), 0);
                    pushToast('info', 'Refreshing logs…');
                  }
                }}
                disabled={!namespaceFilter || !podName || !containerName}
              >
                Refresh
              </button>
            </div>
          </div>
        </div>

        {/* Status summary */}
        <div class="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-600 font-mono flex flex-wrap gap-x-6 gap-y-1">
          <div>
            ns={namespaceFilter ? `"${namespaceFilter}"` : 'null'}
          </div>
          <div>
            pod={podName ? `"${podName}"` : 'null'}
          </div>
          <div>
            container={containerName ? `"${containerName}"` : 'null'}
          </div>
          <div>live="{liveState}"</div>
        </div>

        {loadingPods && (
          <div class="text-[11px] text-slate-500 font-mono">
            loading pods…
          </div>
        )}
        {podsError && (
          <div class="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {podsError}
          </div>
        )}
        {logsError && (
          <div class="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {logsError}
          </div>
        )}

        {/* Log box – full width below controls */}
        <div
          ref={logBoxRef}
          class="w-full rounded-xl border border-slate-200 bg-slate-950 text-[11px] text-slate-100 font-mono p-3 overflow-auto whitespace-pre-wrap h-[420px]"
        >
          {logsText || (
            <span class="text-slate-500">
              No logs yet. Select namespace, pod (and container if needed).
            </span>
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

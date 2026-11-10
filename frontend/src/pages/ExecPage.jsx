// src/pages/ExecPage.jsx
import { h } from 'preact';
import { useState, useEffect, useMemo } from 'preact/hooks';

export default function ExecPage({ token, user }) {
  const [pods, setPods] = useState([]);

  const [namespaceFilter, setNamespaceFilter] = useState(() => {
    if (typeof window === 'undefined') return 'all';
    return localStorage.getItem('exec_ns') || 'all';
  });

  const [selectedPodName, setSelectedPodName] = useState('');
  const [containers, setContainers] = useState([]);
  const [selectedContainer, setSelectedContainer] = useState('');

  const [loadingPods, setLoadingPods] = useState(true);
  const [podsError, setPodsError] = useState('');

  const [commandText, setCommandText] = useState('');
  const [scriptText, setScriptText] = useState('');

  const [runningCommand, setRunningCommand] = useState(false);
  const [runningScript, setRunningScript] = useState(false);

  const [lastResult, setLastResult] = useState(null); // ExecRunResponse
  const [activeOutputTab, setActiveOutputTab] = useState('stdout'); // stdout | stderr | both

  const [toasts, setToasts] = useState([]);

  const isAdmin = (user?.role || '').toLowerCase() === 'admin'; // informational

  const pushToast = (type, message) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  };

  // Remember namespace
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('exec_ns', namespaceFilter);
    }
  }, [namespaceFilter]);

  // Load pods list once (cluster-wide), like other pages
  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    const load = async () => {
      setLoadingPods(true);
      setPodsError('');
      try {
        const res = await fetch('/api/pods', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const text = await res.text();
        if (!res.ok) {
          let msg = text || 'Failed to load pods';
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
          throw new Error('Invalid JSON from /api/pods');
        }
        if (cancelled) return;
        const items = Array.isArray(data.items) ? data.items : [];
        setPods(items);
      } catch (err) {
        console.error('exec page: pods fetch failed', err);
        const msg = err.message || 'Failed to load pods';
        if (!cancelled) {
          setPodsError(msg);
          setPods([]);
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

  // Namespaces from pods
  const namespaces = useMemo(() => {
    const set = new Set(pods.map((p) => p.namespace));
    return Array.from(set).sort();
  }, [pods]);

  // Pods in selected namespace (or all)
  const podsInNamespace = useMemo(() => {
    if (namespaceFilter === 'all' || !namespaceFilter) return pods;
    return pods.filter((p) => p.namespace === namespaceFilter);
  }, [pods, namespaceFilter]);

  // Ensure selection is consistent when ns changes
  useEffect(() => {
    if (!selectedPodName) return;
    const podStillExists = podsInNamespace.some((p) => p.name === selectedPodName);
    if (!podStillExists) {
      setSelectedPodName('');
      setContainers([]);
      setSelectedContainer('');
    }
  }, [podsInNamespace, selectedPodName]);

  // Load pod detail when a pod is selected (to get containers)
  useEffect(() => {
    if (!token) return;
    if (!namespaceFilter || namespaceFilter === 'all') return;
    if (!selectedPodName) return;

    let cancelled = false;

    const loadDetail = async () => {
      setContainers([]);
      setSelectedContainer('');

      try {
        const res = await fetch(
          `/api/pods/${encodeURIComponent(namespaceFilter)}/${encodeURIComponent(
            selectedPodName,
          )}`,
          {
            headers: { Authorization: `Bearer ${token}` },
          },
        );
        const text = await res.text();
        if (!res.ok) {
          let msg = text || 'Failed to load pod detail';
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
          throw new Error('Invalid JSON from pod detail');
        }
        if (cancelled) return;

        const cs = Array.isArray(data.containers) ? data.containers : [];
        const containerNames = cs.map((c) => c.name).filter(Boolean);
        setContainers(containerNames);

        // Choose default container similar to logs: non-sidecar if possible
        let defaultC = '';
        if (containerNames.length === 1) {
          defaultC = containerNames[0];
        } else if (containerNames.length > 1) {
          const preferred = containerNames.find((n) => {
            const ln = String(n || '').toLowerCase();
            if (!ln) return false;
            if (ln.includes('sidecar') || ln.includes('istio')) return false;
            return true;
          });
          defaultC = preferred || containerNames[0];
        }
        setSelectedContainer(defaultC || '');
      } catch (err) {
        console.error('exec page: pod detail fetch failed', err);
        const msg = err.message || 'Failed to load pod detail';
        if (!cancelled) {
          pushToast('error', msg);
        }
      }
    };

    loadDetail();
    return () => {
      cancelled = true;
    };
  }, [token, namespaceFilter, selectedPodName]);

  const handleNamespaceChange = (ns) => {
    setNamespaceFilter(ns);
    // Clear pod/container selection when namespace changes
    setSelectedPodName('');
    setContainers([]);
    setSelectedContainer('');
  };

  const handlePodChange = (name) => {
    setSelectedPodName(name);
    // detail effect will update containers + selectedContainer
  };

  const canRun = namespaceFilter && namespaceFilter !== 'all' && selectedPodName && selectedContainer;

  const runExec = async (mode) => {
    if (!token) return;
    if (!canRun) {
      pushToast('error', 'Select namespace, pod and container first.');
      return;
    }

    const text =
      mode === 'command'
        ? (commandText || '').trim()
        : (scriptText || '').trim();

    if (!text) {
      pushToast('error', mode === 'command' ? 'Command is empty.' : 'Script is empty.');
      return;
    }

    const isCommand = mode === 'command';

    if (isCommand) setRunningCommand(true);
    else setRunningScript(true);

    try {
      const body = {
        namespace: namespaceFilter,
        pod: selectedPodName,
        container: selectedContainer,
        timeoutSeconds: 60,
      };
      if (isCommand) body.command = text;
      else body.script = text;

      const url = isCommand ? '/api/exec/command' : '/api/exec/script';

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      const textResp = await res.text();
      if (!res.ok) {
        let msg = textResp || 'Exec failed';
        try {
          const obj = JSON.parse(textResp);
          msg = obj.error || msg;
        } catch {}
        throw new Error(msg);
      }

      let data;
      try {
        data = JSON.parse(textResp);
      } catch {
        throw new Error('Invalid JSON from exec endpoint');
      }

      setLastResult(data);
      setActiveOutputTab('stdout');

      if (data.success) {
        pushToast(
          'success',
          `${mode === 'command' ? 'Command' : 'Script'} finished in ${
            data.durationMillis ?? '?'
          } ms`,
        );
      } else {
        pushToast(
          'error',
          `${mode === 'command' ? 'Command' : 'Script'} error: ${
            data.error || 'see stderr'
          }`,
        );
      }
    } catch (err) {
      console.error('exec run failed', err);
      const msg = err.message || 'Exec failed';
      pushToast('error', msg);
    } finally {
      if (isCommand) setRunningCommand(false);
      else setRunningScript(false);
    }
  };

  const handleFileUpload = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setScriptText(String(reader.result || ''));
      pushToast('success', `Loaded script: ${file.name}`);
    };
    reader.onerror = () => {
      pushToast('error', `Failed to read script file: ${file.name}`);
    };
    reader.readAsText(file);
  };

  const handleDownloadLog = () => {
    if (!lastResult) {
      pushToast('error', 'No exec output to download yet.');
      return;
    }

    const stdout = lastResult.stdout || '';
    const stderr = lastResult.stderr || '';

    let content = '';
    if (stdout.trim()) {
      content += 'STDOUT:\n' + stdout.trimEnd() + '\n';
    }
    if (stderr.trim()) {
      if (content) content += '\n';
      content += 'STDERR:\n' + stderr.trimEnd() + '\n';
    }
    if (!content.trim()) {
      content = '<no output>\n';
    }

    const ns = lastResult.namespace || 'ns';
    const pod = lastResult.pod || 'pod';

    const nowStr = (() => {
      const raw = lastResult.finishedAt || lastResult.startedAt;
      const d = raw ? new Date(raw) : new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const datePart = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
      const timePart = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
      return `${datePart}_${timePart}`;
    })();

    const fileName = `${pod}_${ns}_${nowStr}.log`;

    if (typeof window === 'undefined') return;
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();

    URL.revokeObjectURL(url);
  };

  const currentOutput = (() => {
    if (!lastResult) return '';
    const stdout = lastResult.stdout || '';
    const stderr = lastResult.stderr || '';
    if (activeOutputTab === 'stdout') return stdout;
    if (activeOutputTab === 'stderr') return stderr;
    // both
    const lines = [];
    if (stdout.trim()) {
      lines.push('=== STDOUT ===');
      lines.push(stdout.trimEnd());
    }
    if (stderr.trim()) {
      if (lines.length) lines.push('');
      lines.push('=== STDERR ===');
      lines.push(stderr.trimEnd());
    }
    if (!lines.length) return '';
    return lines.join('\n');
  })();

  return (
    <>
      <section class="grid gap-4 xl:grid-cols-[1.5fr,1.6fr]">
        {/* Left side: selectors + run cards */}
        <div class="space-y-4">
          {/* Selector card */}
          <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div class="flex items-center justify-between mb-3">
              <div>
                <h2 class="text-sm font-semibold text-slate-800">
                  Exec into pod
                </h2>
                <p class="text-xs text-slate-500">
                  Select namespace, pod and container to run commands or scripts.
                </p>
              </div>
              <div class="text-[11px] text-slate-500 font-mono">
                mode={isAdmin ? '"admin"' : '"readonly"'}
              </div>
            </div>

            {podsError && (
              <div class="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                {podsError}
              </div>
            )}

            <div class="space-y-3 text-xs">
              <div class="grid gap-3 md:grid-cols-2">
                <div class="flex flex-col gap-1">
                  <label class="text-[11px] font-medium text-slate-700">
                    Namespace
                  </label>
                  <select
                    class="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700"
                    value={namespaceFilter}
                    onChange={(e) => handleNamespaceChange(e.target.value)}
                  >
                    <option value="all" disabled>
                      Select…
                    </option>
                    {namespaces.map((ns) => (
                      <option key={ns} value={ns}>
                        {ns}
                      </option>
                    ))}
                  </select>
                </div>

                <div class="flex flex-col gap-1">
                  <label class="text-[11px] font-medium text-slate-700">
                    Pod
                  </label>
                  <select
                    class="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700"
                    value={selectedPodName}
                    onChange={(e) => handlePodChange(e.target.value)}
                    disabled={
                      !namespaceFilter ||
                      namespaceFilter === 'all' ||
                      loadingPods ||
                      podsInNamespace.length === 0
                    }
                  >
                    <option value="">
                      {namespaceFilter === 'all'
                        ? 'Select namespace first'
                        : podsInNamespace.length === 0
                        ? 'No pods'
                        : 'Select pod'}
                    </option>
                    {podsInNamespace.map((p) => (
                      <option key={`${p.namespace}/${p.name}`} value={p.name}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div class="flex flex-col gap-1">
                <label class="text-[11px] font-medium text-slate-700">
                  Container
                </label>
                <select
                  class="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700"
                  value={selectedContainer}
                  onChange={(e) => setSelectedContainer(e.target.value)}
                  disabled={!selectedPodName || containers.length <= 1}
                >
                  {containers.length === 0 && (
                    <option value="">
                      {selectedPodName ? 'Loading containers…' : 'Select pod first'}
                    </option>
                  )}
                  {containers.length === 1 && (
                    <option value={containers[0]}>{containers[0]}</option>
                  )}
                  {containers.length > 1 &&
                    containers.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                </select>
                <p class="text-[10px] text-slate-400">
                  If only one container exists, it&apos;s selected automatically.
                </p>
              </div>

              <div class="flex items-center justify-between text-[11px] text-slate-500 font-mono">
                <span>
                  {loadingPods
                    ? 'loading pods…'
                    : `${podsInNamespace.length} pods in current namespace`}
                </span>
                <span>
                  {namespaceFilter !== 'all'
                    ? `ns="${namespaceFilter}"`
                    : 'ns=<not selected>'}
                </span>
              </div>
            </div>
          </div>

          {/* Run command */}
          <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div class="flex items-center justify-between mb-3">
              <div>
                <h2 class="text-sm font-semibold text-slate-800">
                  Run command
                </h2>
                <p class="text-xs text-slate-500">
                  Runs via <code class="font-mono text-[10px]">/bin/sh -c</code> inside the container.
                </p>
              </div>
            </div>

            <div class="space-y-3">
              <textarea
                rows={3}
                class="w-full rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-800 font-mono placeholder-slate-400"
                placeholder="e.g. ls -la /app"
                value={commandText}
                onInput={(e) => setCommandText(e.target.value)}
              />

              <div class="flex items-center justify-between text-[11px]">
                <span class="text-slate-500">
                  Target:&nbsp;
                  <span class="font-mono">
                    {namespaceFilter && namespaceFilter !== 'all' && selectedPodName
                      ? `${namespaceFilter}/${selectedPodName}/${selectedContainer || '?'}`
                      : 'not fully selected'}
                  </span>
                </span>
                <button
                  type="button"
                  class="rounded-lg border border-slate-300 bg-emerald-50 px-3 py-1.5 text-[11px] font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                  disabled={runningCommand || !canRun}
                  onClick={() => runExec('command')}
                >
                  {runningCommand ? 'Running…' : 'Run command'}
                </button>
              </div>
            </div>
          </div>

          {/* Run script */}
          <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div class="flex items-center justify-between mb-3">
              <div>
                <h2 class="text-sm font-semibold text-slate-800">
                  Run script
                </h2>
                <p class="text-xs text-slate-500">
                  Paste a multi-line script or load from file, then run inside the container.
                </p>
              </div>
              <div class="text-[11px] text-slate-500">
                <input
                  type="file"
                  accept=".sh,.txt,.log,text/plain,*/*"
                  class="text-[10px]"
                  onChange={handleFileUpload}
                />
              </div>
            </div>

            <div class="space-y-3">
              <textarea
                rows={6}
                class="w-full rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-800 font-mono placeholder-slate-400"
                placeholder="#!/bin/sh&#10;echo Hello from inside the pod"
                value={scriptText}
                onInput={(e) => setScriptText(e.target.value)}
              />

              <div class="flex items-center justify-between text-[11px]">
                <span class="text-slate-500">
                  Shell:&nbsp;
                  <span class="font-mono">/bin/sh -c</span>
                </span>
                <button
                  type="button"
                  class="rounded-lg border border-slate-300 bg-slate-50 px-3 py-1.5 text-[11px] font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                  disabled={runningScript || !canRun}
                  onClick={() => runExec('script')}
                >
                  {runningScript ? 'Running…' : 'Run script'}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Right side: output */}
        <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm flex flex-col">
          <div class="flex items-center justify-between mb-3">
            <div>
              <h2 class="text-sm font-semibold text-slate-800">
                Exec output
              </h2>
              <p class="text-xs text-slate-500">
                View stdout / stderr and download the result as a log file.
              </p>
            </div>
            <div class="flex items-center gap-2 text-[11px] text-slate-500">
              <button
                type="button"
                class={
                  'rounded-full px-2 py-0.5 border text-[10px] font-mono ' +
                  (activeOutputTab === 'stdout'
                    ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                    : 'border-slate-200 bg-slate-50 hover:bg-slate-100')
                }
                onClick={() => setActiveOutputTab('stdout')}
              >
                stdout
              </button>
              <button
                type="button"
                class={
                  'rounded-full px-2 py-0.5 border text-[10px] font-mono ' +
                  (activeOutputTab === 'stderr'
                    ? 'border-rose-300 bg-rose-50 text-rose-800'
                    : 'border-slate-200 bg-slate-50 hover:bg-slate-100')
                }
                onClick={() => setActiveOutputTab('stderr')}
              >
                stderr
              </button>
              <button
                type="button"
                class={
                  'rounded-full px-2 py-0.5 border text-[10px] font-mono ' +
                  (activeOutputTab === 'both'
                    ? 'border-slate-300 bg-slate-100 text-slate-800'
                    : 'border-slate-200 bg-slate-50 hover:bg-slate-100')
                }
                onClick={() => setActiveOutputTab('both')}
              >
                both
              </button>
            </div>
          </div>

          <div class="flex items-center justify-between mb-2 text-[11px] text-slate-500 font-mono">
            <span>
              {lastResult
                ? `last=${lastResult.commandType || 'exec'} (${lastResult.durationMillis ?? '?'}ms)`
                : 'No exec has been run yet.'}
            </span>
            <span>
              {lastResult
                ? `${lastResult.namespace || '?'} / ${lastResult.pod || '?'} / ${
                    lastResult.container || '?'
                  }`
                : ''}
            </span>
          </div>

          <div class="flex-1 min-h-[200px] max-h-[420px] rounded-xl border border-slate-200 bg-slate-950 text-slate-50 text-[11px] font-mono p-3 overflow-auto">
            {lastResult ? (
              currentOutput ? (
                <pre class="whitespace-pre-wrap break-words">{currentOutput}</pre>
              ) : (
                <div class="text-slate-400">No output.</div>
              )
            ) : (
              <div class="text-slate-400">
                Run a command or script to see output here.
              </div>
            )}
          </div>

          <div class="mt-3 flex items-center justify-between text-[11px]">
            <div class="text-slate-500">
              {lastResult && lastResult.error && (
                <span class="text-rose-600">
                  error: {lastResult.error}
                </span>
              )}
            </div>
            <button
              type="button"
              class="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-[11px] font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
              disabled={!lastResult}
              onClick={handleDownloadLog}
            >
              Download .log
            </button>
          </div>
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

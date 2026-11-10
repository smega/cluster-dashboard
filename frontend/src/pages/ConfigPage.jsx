import { h } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';

export default function ConfigPage({ token, user }) {
  const [namespaces, setNamespaces] = useState([]);

  const [namespaceFilter, setNamespaceFilter] = useState(() => {
    if (typeof window === 'undefined') return 'all';
    return localStorage.getItem('config_ns') || 'all';
  });

  const [kindFilter, setKindFilter] = useState(() => {
    if (typeof window === 'undefined') return 'all';
    return localStorage.getItem('config_kind') || 'all'; // all | configmap | secret
  });

  const [search, setSearch] = useState('');

  const [configmaps, setConfigmaps] = useState([]);
  const [secrets, setSecrets] = useState([]);

  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');
  const [reloadTick, setReloadTick] = useState(0);

  const [selected, setSelected] = useState(null); // { kind, namespace, name }
  const [detail, setDetail] = useState(null);

  const [showValues, setShowValues] = useState(false);

  const [toasts, setToasts] = useState([]);

  const isAdmin = (user?.role || '').toLowerCase() === 'admin';

  const pushToast = (type, message) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  };

  useEffect(() => {
    if (typeof window !== 'undefined') localStorage.setItem('config_ns', namespaceFilter);
  }, [namespaceFilter]);

  useEffect(() => {
    if (typeof window !== 'undefined') localStorage.setItem('config_kind', kindFilter);
  }, [kindFilter]);

  // reset values toggle whenever selection changes
  useEffect(() => {
    setShowValues(false);
  }, [selected?.kind, selected?.namespace, selected?.name]);

  // namespaces
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
          try { msg = JSON.parse(text).error || msg; } catch {}
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

    return () => { cancelled = true; };
  }, [token]);

  // list load
  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const qs = `?namespace=${encodeURIComponent(namespaceFilter || 'all')}`;

        const [cmRes, sRes] = await Promise.all([
          fetch(`/api/kube/configmaps${qs}`, { headers: { Authorization: `Bearer ${token}` } }),
          fetch(`/api/kube/secrets${qs}`, { headers: { Authorization: `Bearer ${token}` } })
        ]);

        const cmText = await cmRes.text();
        if (!cmRes.ok) {
          let msg = cmText || 'Failed to load configmaps';
          try { msg = JSON.parse(cmText).error || msg; } catch {}
          throw new Error(msg);
        }

        const sText = await sRes.text();
        if (!sRes.ok) {
          let msg = sText || 'Failed to load secrets';
          try { msg = JSON.parse(sText).error || msg; } catch {}
          throw new Error(msg);
        }

        const cmData = JSON.parse(cmText);
        const sData = JSON.parse(sText);

        if (cancelled) return;

        const cms = Array.isArray(cmData.items) ? cmData.items : [];
        const secs = Array.isArray(sData.items) ? sData.items : [];

        setConfigmaps(cms);
        setSecrets(secs);

        // keep selection if still present
        if (selected) {
          const exists =
            (selected.kind === 'ConfigMap' &&
              cms.some((x) => x.name === selected.name && x.namespace === selected.namespace)) ||
            (selected.kind === 'Secret' &&
              secs.some((x) => x.name === selected.name && x.namespace === selected.namespace));

          if (!exists) {
            setSelected(null);
            setDetail(null);
          }
        }
      } catch (err) {
        console.error('config inventory fetch failed', err);
        const msg = err.message || 'Failed to load config inventory';
        if (!cancelled) {
          setError(msg);
          setConfigmaps([]);
          setSecrets([]);
          setSelected(null);
          setDetail(null);
          pushToast('error', msg);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, namespaceFilter, reloadTick]);

  // detail load (refetch when showValues changes)
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

        const q = showValues ? '?includeData=1' : '';
        const path =
          kind === 'ConfigMap'
            ? `/api/kube/configmaps/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}${q}`
            : `/api/kube/secrets/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}${q}`;

        const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
        const text = await res.text();
        if (!res.ok) {
          let msg = text || 'Failed to load details';
          try { msg = JSON.parse(text).error || msg; } catch {}
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

    return () => { cancelled = true; };
  }, [token, selected, showValues]);

  const rows = useMemo(() => {
    const cmRows = configmaps.map((x) => ({
      kind: 'ConfigMap',
      name: x.name,
      namespace: x.namespace,
      keys: x.keys ?? 0,
      type: '',
      immutable: x.immutable,
      age: x.age || '-'
    }));

    const sRows = secrets.map((x) => ({
      kind: 'Secret',
      name: x.name,
      namespace: x.namespace,
      keys: x.keys ?? 0,
      type: x.type || '',
      immutable: x.immutable,
      age: x.age || '-'
    }));

    return [...cmRows, ...sRows].sort((a, b) => {
      if (a.namespace === b.namespace) {
        if (a.kind === b.kind) return a.name.localeCompare(b.name);
        return a.kind.localeCompare(b.kind);
      }
      return a.namespace.localeCompare(b.namespace);
    });
  }, [configmaps, secrets]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (kindFilter === 'configmap' && r.kind !== 'ConfigMap') return false;
      if (kindFilter === 'secret' && r.kind !== 'Secret') return false;
      if (!q) return true;
      return `${r.namespace}/${r.name} ${r.kind} ${r.type}`.toLowerCase().includes(q);
    });
  }, [rows, search, kindFilter]);

  return (
    <>
      <section class="grid gap-4 lg:grid-cols-[2fr,1.3fr] min-w-0">
        {/* Left: list */}
        <div class="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div class="flex flex-wrap items-center justify-between gap-3 mb-3">
            <div class="min-w-0">
              <h2 class="text-sm font-semibold text-slate-800">Config & Secrets</h2>
              <p class="text-xs text-slate-500">
                Inventory + optional values (use “Load values” in the detail panel).
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
                value={kindFilter}
                onChange={(e) => setKindFilter(e.target.value)}
              >
                <option value="all">All</option>
                <option value="configmap">ConfigMaps</option>
                <option value="secret">Secrets</option>
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

          <div class="flex items-center justify-between mb-2 text-[11px] text-slate-500 font-mono min-w-0">
            {loading ? (
              <span>loading inventory…</span>
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
                    <th class="text-left font-medium px-2 py-1">Type</th>
                    <th class="text-left font-medium px-2 py-1">Keys</th>
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
                        {typeof r.immutable === 'boolean' && (
                          <div class="text-[11px] text-slate-500 font-mono">
                            immutable={String(r.immutable)}
                          </div>
                        )}
                      </td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-600 font-mono">{r.namespace}</td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-700 font-mono">{r.type || '-'}</td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-700 font-mono">{r.keys}</td>
                      <td class="px-2 py-1 align-top text-[11px] text-slate-600 font-mono">{r.age}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {filtered.length === 0 && (
                <div class="mt-3 text-xs text-slate-500">
                  No items match the current filters.
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
              <p class="text-xs text-slate-500">
                Keys + metadata. Values only load when requested.
              </p>
            </div>

            <div class="min-w-0 flex items-center gap-2">
              {selected && (
                <button
                  type="button"
                  class="shrink-0 rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-100"
                  onClick={() => setShowValues((v) => !v)}
                >
                  {showValues ? 'Hide values' : 'Load values'}
                </button>
              )}

              {selected && (
                <div
                  class="min-w-0 max-w-[10rem] sm:max-w-[16rem] text-[11px] text-slate-500 font-mono text-right truncate"
                  title={`${selected.namespace}/${selected.name}`}
                >
                  {selected.namespace}/{selected.name}
                </div>
              )}
            </div>
          </div>

          {!selected && (
            <div class="text-xs text-slate-500">
              No item selected. Click a row on the left to see details.
            </div>
          )}

          {selected && (
            <DetailPanel
              detail={detail}
              loading={detailLoading}
              showValues={showValues}
              onToggleValues={() => setShowValues((v) => !v)}
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

function KindBadge({ kind }) {
  const cls =
    kind === 'Secret'
      ? 'bg-rose-50 text-rose-700 border-rose-200'
      : 'bg-indigo-50 text-indigo-700 border-indigo-200';

  return (
    <span class={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-mono ${cls}`}>
      {kind}
    </span>
  );
}

function DetailPanel({ detail, loading, showValues, onToggleValues }) {
  if (loading) {
    return <div class="text-[11px] text-slate-500 font-mono">loading details…</div>;
  }
  if (!detail) {
    return <div class="text-xs text-slate-500">No details loaded.</div>;
  }

  const meta = detail.meta || {};
  const keys = Array.isArray(detail.keys) ? detail.keys : [];

  return (
    <div class="space-y-4 text-xs min-w-0">
      <div class="flex flex-wrap items-center gap-3 min-w-0">
        <KindBadge kind={detail.kind || '-'} />
        {detail.type ? <span class="font-mono text-slate-600 break-all">type={detail.type}</span> : null}
        <span class="font-mono text-slate-600">keys={keys.length}</span>
        <span class="font-mono text-slate-600">age={detail.age || '-'}</span>
        {typeof detail.immutable === 'boolean' ? (
          <span class="font-mono text-slate-600">immutable={String(detail.immutable)}</span>
        ) : null}
        {showValues ? (
          <span class="font-mono text-rose-700 bg-rose-50 border border-rose-200 rounded-full px-2 py-0.5 text-[10px]">
            values=ON
          </span>
        ) : null}
      </div>

      <div class="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 flex flex-col gap-1 min-w-0">
        <div class="text-[11px] text-slate-600 font-mono break-all">uid={meta.uid || '-'}</div>
        <div class="text-[11px] text-slate-600 font-mono break-all">created={meta.creationTimestamp || '-'}</div>
        <div class="text-[11px] text-slate-600 font-mono break-all">rv={meta.resourceVersion || '-'}</div>
      </div>

      <div class="min-w-0">
        <h3 class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em] mb-1">
          Keys
        </h3>
        {keys.length === 0 ? (
          <div class="text-[11px] text-slate-500">No keys.</div>
        ) : (
          <div class="space-y-1 text-[11px] min-w-0">
            {keys.map((k) => (
              <div key={k.key} class="flex items-center justify-between gap-2 min-w-0">
                <span class="font-mono text-slate-800 break-all min-w-0">{k.key}</span>
                <span class="font-mono text-slate-500 shrink-0">
                  {k.from ? `${k.from} · ` : ''}{k.size}B
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div class="grid gap-4 md:grid-cols-2 min-w-0">
        <div class="min-w-0">
          <h3 class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em] mb-1">
            Labels
          </h3>
          <KeyValueList obj={meta.labels} emptyLabel="No labels." />
        </div>
        <div class="min-w-0">
          <h3 class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em] mb-1">
            Annotations
          </h3>
          <KeyValueList obj={meta.annotations} emptyLabel="No annotations." />
        </div>
      </div>

      <ValuesPanel detail={detail} showValues={showValues} onToggleValues={onToggleValues} />

      <div class="min-w-0">
        <h3 class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em] mb-1">
          Raw (detail response)
        </h3>
        <pre class="max-w-full text-[11px] bg-white border border-slate-200 rounded-xl p-3 overflow-auto font-mono text-slate-800 whitespace-pre-wrap break-all">
{JSON.stringify(detail, null, 2)}
        </pre>
      </div>
    </div>
  );
}

function ValuesPanel({ detail, showValues, onToggleValues }) {
  if (!showValues) {
    return (
      <div class="rounded-xl border border-slate-200 bg-white px-3 py-2 text-[11px] text-slate-500 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between min-w-0">
        <div class="min-w-0 break-words">
          Values are hidden. Click <span class="font-mono">Load values</span> to fetch them.
        </div>
        <button
          type="button"
          class="shrink-0 w-full sm:w-auto rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-100"
          onClick={onToggleValues}
        >
          Load values
        </button>
      </div>
    );
  }

  if (detail.kind === 'ConfigMap') {
    const data = detail.data || {};
    const binary = detail.binaryDataB64 || {};

    return (
      <div class="space-y-3 min-w-0">
        <div class="flex flex-wrap items-center justify-between gap-2 min-w-0">
          <h3 class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em]">
            Data
          </h3>
          <button
            type="button"
            class="shrink-0 rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-100"
            onClick={onToggleValues}
          >
            Hide values
          </button>
        </div>

        <KVPre obj={data} emptyLabel="No data entries." />

        <div class="flex flex-wrap items-center justify-between gap-2 mt-3 min-w-0">
          <h3 class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em]">
            BinaryData (base64)
          </h3>
        </div>

        <KVPre obj={binary} emptyLabel="No binaryData entries." />
      </div>
    );
  }

  // Secret
  return (
    <div class="space-y-2 min-w-0">
      <div class="flex flex-wrap items-center justify-between gap-2 min-w-0">
        <h3 class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em]">
          Data (base64)
        </h3>
        <button
          type="button"
          class="shrink-0 rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-100"
          onClick={onToggleValues}
        >
          Hide values
        </button>
      </div>

      <SecretValues dataB64={detail.dataB64 || {}} />
    </div>
  );
}

function KVPre({ obj, emptyLabel }) {
  const entries = Object.entries(obj || {});
  if (entries.length === 0) {
    return <div class="text-[11px] text-slate-500">{emptyLabel}</div>;
  }

  return (
    <div class="space-y-2 min-w-0">
      {entries.map(([k, v]) => (
        <div key={k} class="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 min-w-0">
          <div class="text-[11px] text-slate-600 font-mono mb-1 break-all">{k}</div>
          <pre class="max-w-full text-[11px] font-mono text-slate-800 whitespace-pre-wrap break-all overflow-auto">
{String(v)}
          </pre>
        </div>
      ))}
    </div>
  );
}

function SecretValues({ dataB64 }) {
  const entries = Object.entries(dataB64 || {});
  const [decoded, setDecoded] = useState({}); // key -> decoded string

  if (entries.length === 0) {
    return <div class="text-[11px] text-slate-500">No secret data entries.</div>;
  }

  const decode = (k, b64) => {
    try {
      const bin = atob(String(b64 || ''));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

      let text = '';
      try {
        text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      } catch {
        text = bin;
      }

      setDecoded((prev) => ({ ...prev, [k]: text }));
    } catch (e) {
      setDecoded((prev) => ({ ...prev, [k]: `<<decode failed: ${e?.message || e}>>` }));
    }
  };

  const hide = (k) => {
    setDecoded((prev) => {
      const copy = { ...prev };
      delete copy[k];
      return copy;
    });
  };

  return (
    <div class="space-y-2 min-w-0">
      {entries.map(([k, b64]) => (
        <div key={k} class="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 min-w-0">
          <div class="flex items-center justify-between gap-2 mb-1 min-w-0">
            <div class="text-[11px] text-slate-600 font-mono break-all min-w-0">{k}</div>
            {decoded[k] == null ? (
              <button
                type="button"
                class="shrink-0 rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-100"
                onClick={() => decode(k, b64)}
              >
                Decode
              </button>
            ) : (
              <button
                type="button"
                class="shrink-0 rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-100"
                onClick={() => hide(k)}
              >
                Hide decode
              </button>
            )}
          </div>

          <div class="text-[11px] text-slate-500 font-mono">base64:</div>
          <pre class="max-w-full text-[11px] font-mono text-slate-800 whitespace-pre-wrap break-all overflow-auto mb-2">
{String(b64)}
          </pre>

          {decoded[k] != null && (
            <>
              <div class="text-[11px] text-rose-700 font-mono">decoded (be careful):</div>
              <pre class="max-w-full text-[11px] font-mono text-slate-900 whitespace-pre-wrap break-all overflow-auto">
{decoded[k]}
              </pre>
            </>
          )}
        </div>
      ))}
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

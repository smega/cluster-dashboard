import { h } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';

export default function ImageProvenancePage({ token }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [namespaceFilter, setNamespaceFilter] = useState(() => {
    if (typeof window === 'undefined') return 'all';
    return localStorage.getItem('prov_ns') || 'all';
  });
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('prov_ns', namespaceFilter);
    }
  }, [namespaceFilter]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const nsParam = namespaceFilter && namespaceFilter !== 'all'
          ? `?namespace=${encodeURIComponent(namespaceFilter)}`
          : `?namespace=all`;
        const res = await fetch(`/api/kube/provenance${nsParam}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || 'Failed to load provenance');

        if (!cancelled) {
          setItems(Array.isArray(data.items) ? data.items : []);
          setSelected(null);
        }
      } catch (e) {
        if (!cancelled) setError(e.message || 'Failed to load provenance');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [token, namespaceFilter]);

  const namespaces = useMemo(() => {
    const s = new Set(items.map((x) => x.namespace));
    return Array.from(s).sort();
  }, [items]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((w) => {
      const text = `${w.kind} ${w.namespace}/${w.name}`.toLowerCase();
      if (text.includes(q)) return true;
      const cs = Array.isArray(w.containers) ? w.containers : [];
      return cs.some((c) => `${c.image || ''} ${c.digest || ''}`.toLowerCase().includes(q));
    });
  }, [items, search]);

  return (
    <section class="grid gap-4 lg:grid-cols-[2fr,1.3fr]">
      {/* Left */}
      <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div>
            <h2 class="text-sm font-semibold text-slate-800">Image provenance</h2>
            <p class="text-xs text-slate-500">
              Workload template image + resolved digest (best-effort from pods).
            </p>
          </div>

          <div class="flex flex-wrap items-center gap-2">
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

            <input
              class="w-56 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 placeholder-slate-400"
              placeholder="Search workloads/images…"
              value={search}
              onInput={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        {loading && <div class="text-xs text-slate-500 font-mono">loading…</div>}

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
                  <th class="text-left font-medium px-2 py-1">Namespace</th>
                  <th class="text-left font-medium px-2 py-1">Name</th>
                  <th class="text-left font-medium px-2 py-1">Age</th>
                  <th class="text-left font-medium px-2 py-1">Digest?</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((w) => {
                  const hasDigest = (w.containers || []).some((c) => (c.digest || '').includes('sha256:'));
                  return (
                    <tr
                      key={`${w.kind}-${w.namespace}-${w.name}`}
                      class={
                        'cursor-pointer bg-slate-50 hover:bg-slate-100 ' +
                        (selected?.kind === w.kind && selected?.namespace === w.namespace && selected?.name === w.name
                          ? 'outline outline-1 outline-emerald-400/70'
                          : '')
                      }
                      onClick={() => setSelected(w)}
                    >
                      <td class="px-2 py-1 font-mono text-[11px] text-slate-700">{w.kind}</td>
                      <td class="px-2 py-1 font-mono text-[11px] text-slate-600">{w.namespace}</td>
                      <td class="px-2 py-1 font-mono text-[11px] text-slate-800">{w.name}</td>
                      <td class="px-2 py-1 font-mono text-[11px] text-slate-600">{w.age}</td>
                      <td class="px-2 py-1 font-mono text-[11px]">
                        <span class={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] ${
                          hasDigest ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-slate-100 text-slate-600'
                        }`}>
                          {hasDigest ? 'yes' : 'no'}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {filtered.length === 0 && (
              <div class="mt-3 text-xs text-slate-500">No workloads match the filters.</div>
            )}
          </div>
        )}
      </div>

      {/* Right */}
      <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm max-w-full overflow-hidden">
        <div class="flex items-center justify-between mb-3">
          <div>
            <h2 class="text-sm font-semibold text-slate-800">Details</h2>
            <p class="text-xs text-slate-500">Per-container image + digest + source pod.</p>
          </div>
          {selected && (
            <div class="text-[11px] text-slate-500 font-mono break-all text-right max-w-[55%]">
              {selected.namespace}/{selected.name}
            </div>
          )}
        </div>

        {!selected && (
          <div class="text-xs text-slate-500">
            Select a workload on the left.
          </div>
        )}

        {selected && selected.warning && (
          <div class="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {selected.warning}
          </div>
        )}

        {selected && (
          <div class="space-y-2 max-w-full">
            {(selected.containers || []).map((c) => (
              <div key={c.container} class="rounded-lg border border-slate-200 bg-white px-3 py-2 max-w-full">
                <div class="flex items-center justify-between gap-2">
                  <div class="font-mono text-[11px] text-slate-800">{c.container}</div>
                  <div class="font-mono text-[11px] text-slate-500">
                    ready={c.ready ? 'true' : 'false'}
                  </div>
                </div>

                <div class="mt-1 text-[11px] text-slate-500 break-all">
                  image: <span class="font-mono text-slate-800">{c.image || '-'}</span>
                </div>

                <div class="mt-1 text-[11px] text-slate-500 break-all">
                  digest: <span class="font-mono text-slate-800">{c.digest || '-'}</span>
                </div>

                <div class="mt-1 text-[11px] text-slate-500 break-all">
                  pod: <span class="font-mono text-slate-700">{c.pod || '-'}</span>
                </div>

                <div class="mt-1 text-[11px] text-slate-500 break-all">
                  imageID: <span class="font-mono text-slate-700">{c.imageID || '-'}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

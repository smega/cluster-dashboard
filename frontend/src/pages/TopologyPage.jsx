import { h } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import cytoscape from "cytoscape";

function statusTone(status) {
  const s = String(status || "").toLowerCase();
  if (s === "ready") return "ready";
  if (s === "idle") return "idle";

  if (s.includes("noendpoints") || s.includes("nobackends") || s.includes("notready")) return "bad";
  if (s.includes("unknown")) return "unknown";

  if (
    s.includes("progress") ||
    s.includes("provision") ||
    s.includes("pending") ||
    s.includes("containercreating") ||
    s.includes("podinitializing")
  )
    return "progress";

  if (s.includes("terminat")) return "term";
  if (
    s.includes("fail") ||
    s.includes("crash") ||
    s.includes("error") ||
    s.includes("imagepull") ||
    s.includes("backoff") ||
    s.includes("oom")
  )
    return "bad";

  return "unknown";
}

function defaultKindEnabled() {
  return {
    PublicEndpoint: true,
    Ingress: true,
    Service: true,
    Deployment: true,
    StatefulSet: true,
    DaemonSet: true,
    ReplicaSet: false,
    Pod: true,
    Container: false,
    Job: false,
    CronJob: false,
    Unknown: true,
  };
}

function truncateMiddle(s, max) {
  if (!s || s.length <= max) return s || "";
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

function buildCyElements(graph, filters) {
  const q = (filters.search || "").trim().toLowerCase();
  const onlyUnhealthy = !!filters.onlyUnhealthy;
  const kindEnabled = filters.kindEnabled || {};

  const nodes = [];
  const allowed = new Set();

  for (const n of graph?.nodes || []) {
    const kind = n.kind || "Unknown";
    if (kindEnabled[kind] === false) continue;

    const tone = statusTone(n.status);
    const status = String(n.status || "").trim();

    if (q) {
      const hay = `${kind} ${n.name || ""} ${n.namespace || ""} ${n.status || ""}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }

    if (onlyUnhealthy) {
      if (tone === "ready" || tone === "idle") continue;
    }

    nodes.push({
      data: {
        id: n.id,
        label: `${kind}\n${truncateMiddle(n.name || "", 18)}${status ? `\n${status}` : ""}`,
        kind,
        name: n.name,
        namespace: n.namespace,
        status: n.status,
        tone,
        detail: n.detail || {},
      },
    });
    allowed.add(n.id);
  }

  const edges = [];
  for (const e of graph?.edges || []) {
    if (!allowed.has(e.from) || !allowed.has(e.to)) continue;
    edges.push({
      data: {
        id: e.id,
        source: e.from,
        target: e.to,
        kind: e.kind || "link",
      },
    });
  }

  return { nodes, edges };
}

// SSE over fetch streaming (supports Authorization header)
function openSSEFetch(url, { headers, onEvent, onOpen, onError }) {
  const ctrl = new AbortController();

  (async () => {
    try {
      const res = await fetch(url, { method: "GET", headers, signal: ctrl.signal });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `HTTP ${res.status}`);
      }

      onOpen && onOpen();

      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buf = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buf += decoder.decode(value, { stream: true });

        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);

          const trimmed = chunk.trim();
          if (!trimmed || trimmed.startsWith(":")) continue;

          let eventName = "message";
          const dataLines = [];

          for (const line of chunk.split("\n")) {
            if (line.startsWith("event:")) eventName = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
          }

          const data = dataLines.join("\n");
          onEvent && onEvent(eventName, data);
        }
      }

      throw new Error("stream closed");
    } catch (e) {
      if (!ctrl.signal.aborted) onError && onError(e);
    }
  })();

  return () => ctrl.abort();
}

function parseNamespaces(payload) {
  if (!payload) return [];

  if (Array.isArray(payload)) {
    return payload.map(String).filter(Boolean);
  }

  const arr =
    (Array.isArray(payload.namespaces) && payload.namespaces) ||
    (Array.isArray(payload.items) && payload.items) ||
    [];

  if (arr.length === 0) return [];

  if (typeof arr[0] === "string") return arr.map(String).filter(Boolean);

  return arr
    .map((x) => String(x?.name || x?.namespace || x?.metadata?.name || ""))
    .filter(Boolean);
}

function badgeClassForBackend(state) {
  const s = String(state || "").toLowerCase();
  if (s === "ready") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (s === "down") return "bg-rose-50 text-rose-700 border-rose-200";
  if (s === "unknown") return "bg-amber-50 text-amber-700 border-amber-200";
  return "bg-slate-50 text-slate-700 border-slate-200";
}

function safeHostToURL(host, path = "/") {
  const h = String(host || "").trim();
  if (!h || h.startsWith("(")) return null;

  let p = String(path || "/");
  if (!p || p.startsWith("(")) p = "/";
  if (!p.startsWith("/")) p = "/" + p;

  const base = /^https?:\/\//i.test(h) ? h : `https://${h}`;
  return base.replace(/\/+$/, "") + p;
}

function summarizeIngressHostState(paths, host) {
  const list = Array.isArray(paths) ? paths : [];
  const relevant = list.filter((p) => String(p?.host || "") === String(host || ""));
  if (relevant.length === 0) return { state: "unknown", reason: "no paths" };

  let anyReady = false;
  let anyUnknown = false;
  for (const p of relevant) {
    const s = String(p?.backendState || "").toLowerCase();
    if (s === "ready") anyReady = true;
    else if (s === "unknown" || !s) anyUnknown = true;
  }

  if (anyReady) return { state: "ready", reason: "" };
  if (anyUnknown) return { state: "unknown", reason: "backend unknown" };
  return { state: "down", reason: "no ready backends" };
}

export default function TopologyPage({ token, user }) {
  const cyRef = useRef(null);
  const containerRef = useRef(null);
  const closeStreamRef = useRef(null);

  const [namespaces, setNamespaces] = useState([]);
  const [nsLoading, setNsLoading] = useState(false);
  const [nsError, setNsError] = useState("");

  const [namespace, setNamespace] = useState(() => {
    if (typeof window === "undefined") return "default";
    return localStorage.getItem("topology_ns") || "default";
  });

  const [nsMode, setNsMode] = useState("select");
  const [customNS, setCustomNS] = useState("");

  const [graph, setGraph] = useState(null);
  const [selected, setSelected] = useState(null);

  const [filters, setFilters] = useState({
    search: "",
    onlyUnhealthy: false,
    kindEnabled: defaultKindEnabled(),
    floating: false,
  });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [connState, setConnState] = useState("idle");
  const [reloadTick, setReloadTick] = useState(0);

  const isAdmin = (user?.role || "").toLowerCase() === "admin";

  const authHeaders = useMemo(() => {
    return token ? { Authorization: `Bearer ${token}` } : {};
  }, [token]);

  useEffect(() => {
    if (typeof window !== "undefined") localStorage.setItem("topology_ns", namespace);
  }, [namespace]);

  // Fetch namespaces list
  useEffect(() => {
    if (!token) return;

    let cancelled = false;
    const load = async () => {
      setNsLoading(true);
      setNsError("");
      try {
        const res = await fetch("/api/kube/namespaces", { headers: authHeaders });
        const text = await res.text();
        if (!res.ok) {
          let msg = text || "Failed to load namespaces";
          try { msg = JSON.parse(text).error || msg; } catch {}
          throw new Error(msg);
        }

        const data = JSON.parse(text);
        const list = parseNamespaces(data).sort();

        if (cancelled) return;

        setNamespaces(list);

        if (list.length > 0 && !list.includes(namespace)) {
          setNsMode("custom");
          setCustomNS(namespace);
        } else {
          setNsMode("select");
        }
      } catch (e) {
        if (!cancelled) {
          setNamespaces([]);
          setNsError(e?.message || "Failed to load namespaces");
        }
      } finally {
        if (!cancelled) setNsLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const effectiveNamespace = nsMode === "custom" ? (customNS || "default") : namespace;

  // Re-run the initial layout when the namespace changes, since the new
  // node set has no prior positions (otherwise they'd all stack at origin).
  useEffect(() => {
    if (cyRef.current) cyRef.current.__laidOutOnce = false;
  }, [effectiveNamespace]);

  const cyElements = useMemo(() => buildCyElements(graph, filters), [graph, filters]);

  // Init cytoscape once
  useEffect(() => {
    if (!containerRef.current) return;
    if (cyRef.current) return;

    const cy = cytoscape({
      container: containerRef.current,
      elements: [],
      wheelSensitivity: 0.2,
      selectionType: "single",
      style: [
        {
          selector: "node",
          style: {
            label: "data(label)",
            "text-wrap": "wrap",
            "text-max-width": 58,
            "font-size": 8,
            "text-valign": "center",
            "text-halign": "center",
            color: "#0b1220",
            "background-opacity": 0.95,
            "border-width": 1,
            "border-color": "#243046",
            width: 64,
            height: 64,
          },
        },
        { selector: 'node[kind = "Pod"]', style: { shape: "round-rectangle", width: 92, height: 60, "text-max-width": 82 } },
        { selector: 'node[kind = "Service"]', style: { shape: "rectangle", width: 92, height: 56, "text-max-width": 82 } },
        { selector: 'node[kind = "Ingress"]', style: { shape: "diamond", width: 86, height: 86, "text-max-width": 48 } },
        {
          selector:
            'node[kind = "Deployment"], node[kind = "StatefulSet"], node[kind = "DaemonSet"], node[kind="ReplicaSet"]',
          style: { shape: "hexagon", width: 92, height: 92, "text-max-width": 62 },
        },
        { selector: 'node[kind = "Container"]', style: { shape: "ellipse", width: 48, height: 48, "font-size": 7, "text-max-width": 36 } },
        { selector: 'node[kind = "PublicEndpoint"]', style: { shape: "triangle", width: 64, height: 64, "font-size": 7, "text-max-width": 36 } },

        { selector: 'node[tone = "ready"]', style: { "background-color": "#bbf7d0", "border-color": "#16a34a" } },
        { selector: 'node[tone = "progress"]', style: { "background-color": "#fde68a", "border-color": "#d97706" } },
        { selector: 'node[tone = "bad"]', style: { "background-color": "#fecaca", "border-color": "#dc2626" } },
        { selector: 'node[tone = "idle"]', style: { "background-color": "#e5e7eb", "border-color": "#64748b" } },
        { selector: 'node[tone = "term"]', style: { "background-color": "#e2e8f0", "border-color": "#334155" } },
        { selector: 'node[tone = "unknown"]', style: { "background-color": "#e0f2fe", "border-color": "#0284c7" } },

        {
          selector: "edge",
          style: {
            width: 1.2,
            "curve-style": "bezier",
            "target-arrow-shape": "triangle",
            "line-color": "#64748b",
            "target-arrow-color": "#64748b",
            "arrow-scale": 0.8,
            "line-opacity": 0.7,
          },
        },
        { selector: 'edge[kind = "ingress_backend"]', style: { width: 1.8, "line-style": "dashed" } },
        { selector: ":selected", style: { "border-width": 3, "border-color": "#111827" } },
      ],
      layout: { name: "cose", animate: true, fit: true, padding: 40 },
    });

    cy.on("tap", "node", (evt) => {
      const n = evt.target;
      setSelected({ id: n.id(), ...n.data() });
    });

    cy.on("tap", (evt) => {
      if (evt.target === cy) setSelected(null);
    });

    cyRef.current = cy;
    return () => {
      try { cy.destroy(); } catch {}
      cyRef.current = null;
    };
  }, []);

  // Upsert elements
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    const nextNodes = cyElements.nodes;
    const nextEdges = cyElements.edges;

    const nextIds = new Set();
    for (const el of [...nextNodes, ...nextEdges]) nextIds.add(el.data.id);

    cy.batch(() => {
      cy.elements().forEach((e) => {
        if (!nextIds.has(e.id())) e.remove();
      });

      for (const n of nextNodes) {
        const existing = cy.getElementById(n.data.id);
        if (existing && existing.length) existing.data(n.data);
        else cy.add(n);
      }

      for (const e of nextEdges) {
        const existing = cy.getElementById(e.data.id);
        if (existing && existing.length) existing.data(e.data);
        else cy.add(e);
      }
    });

    if (!cy.__laidOutOnce && (graph?.nodes || []).length > 0) {
      cy.__laidOutOnce = true;
      try {
        cy.layout({ name: "cose", animate: true, randomize: true, fit: true, padding: 40 }).run();
      } catch {}
    }
  }, [cyElements, graph]);

  // Snapshot + stream
  useEffect(() => {
    if (!token) {
      setConnState("idle");
      setLoading(false);
      return;
    }

    let cancelled = false;

    const closeStream = () => {
      try { closeStreamRef.current && closeStreamRef.current(); } catch {}
      closeStreamRef.current = null;
    };

    const run = async () => {
      setLoading(true);
      setError("");
      setConnState("connecting");
      closeStream();

      try {
        const res = await fetch(`/api/topology/snapshot?ns=${encodeURIComponent(effectiveNamespace)}`, {
          headers: authHeaders,
        });
        const text = await res.text();

        if (!res.ok) {
          let msg = text || "Failed to load topology snapshot";
          try { msg = JSON.parse(text).error || msg; } catch {}
          throw new Error(msg);
        }

        const data = JSON.parse(text);
        if (cancelled) return;

        setGraph(data);
        setConnState("live");

        let backoff = 1000;

        const startStream = () => {
          if (cancelled) return;

          const close = openSSEFetch(`/api/topology/stream?ns=${encodeURIComponent(effectiveNamespace)}`, {
            headers: authHeaders,
            onOpen: () => {
              if (!cancelled) setConnState("live");
              backoff = 1000;
            },
            onEvent: (event, payload) => {
              if (cancelled) return;
              if (event !== "snapshot") return;
              try { setGraph(JSON.parse(payload)); } catch {}
            },
            onError: () => {
              if (cancelled) return;
              setConnState("connecting");
              setTimeout(() => startStream(), backoff);
              backoff = Math.min(backoff * 2, 15000);
            },
          });

          closeStreamRef.current = close;
        };

        startStream();
      } catch (err) {
        if (!cancelled) {
          setError(err.message || "Failed to load topology");
          setConnState("error");
          setGraph(null);
          setSelected(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    run();

    return () => {
      cancelled = true;
      closeStream();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, effectiveNamespace, reloadTick]);

  const counts = useMemo(() => {
    const byKind = {};
    for (const n of graph?.nodes || []) byKind[n.kind] = (byKind[n.kind] || 0) + 1;
    return byKind;
  }, [graph]);

  return (
    <>
      <section class="grid gap-4 lg:grid-cols-[2fr,1.3fr] min-w-0">
        <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm min-w-0">
          <div class="flex flex-wrap items-center justify-between gap-3 mb-3">
            <div class="min-w-0">
              <h2 class="text-sm font-semibold text-slate-800">Topology</h2>
              <p class="text-xs text-slate-500">Live graph: Ingress → Service → Pod → Container</p>
            </div>

            <div class="flex flex-wrap items-center gap-2 text-xs">
              <select
                class="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700"
                value={nsMode === "custom" ? "__custom__" : namespace}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "__custom__") {
                    setNsMode("custom");
                    setCustomNS(namespace);
                  } else {
                    setNsMode("select");
                    setNamespace(v);
                    setSelected(null);
                  }
                }}
                disabled={nsLoading}
                title={nsLoading ? "Loading namespaces..." : ""}
              >
                {namespaces.length === 0 ? (
                  <option value="default">default</option>
                ) : (
                  <>
                    {namespaces.map((ns) => (
                      <option key={ns} value={ns}>{ns}</option>
                    ))}
                    <option value="__custom__">Custom…</option>
                  </>
                )}
              </select>

              {nsMode === "custom" && (
                <input
                  type="text"
                  class="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 placeholder-slate-400"
                  value={customNS}
                  onInput={(e) => setCustomNS(e.target.value)}
                  placeholder="namespace name"
                />
              )}

              <input
                type="text"
                placeholder="Search kind / name / status…"
                class="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 placeholder-slate-400"
                value={filters.search}
                onInput={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
              />

              <label class="inline-flex items-center gap-2 text-[11px] text-slate-700">
                <input
                  type="checkbox"
                  checked={filters.onlyUnhealthy}
                  onChange={(e) => setFilters((f) => ({ ...f, onlyUnhealthy: e.target.checked }))}
                />
                only unhealthy
              </label>

              <button
                type="button"
                class="rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-100"
                onClick={() => setReloadTick((r) => r + 1)}
              >
                Refresh
              </button>

              <button
                type="button"
                class="rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-100"
                onClick={() => {
                  const cy = cyRef.current;
                  if (!cy) return;
                  try { cy.fit(undefined, 60); } catch {}
                }}
              >
                Fit
              </button>

              <div class="inline-flex items-center rounded-lg border border-slate-300 bg-white overflow-hidden">
                <button
                  type="button"
                  aria-label="Zoom out"
                  class="px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-100 border-r border-slate-300"
                  onClick={() => {
                    const cy = cyRef.current;
                    if (!cy) return;
                    try {
                      const level = cy.zoom() * 0.8;
                      cy.animate({ zoom: level, center: { eles: cy.elements() } }, { duration: 150 });
                    } catch {}
                  }}
                >
                  −
                </button>
                <button
                  type="button"
                  aria-label="Zoom in"
                  class="px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-100"
                  onClick={() => {
                    const cy = cyRef.current;
                    if (!cy) return;
                    try {
                      const level = cy.zoom() * 1.25;
                      cy.animate({ zoom: level, center: { eles: cy.elements() } }, { duration: 150 });
                    } catch {}
                  }}
                >
                  +
                </button>
              </div>
            </div>
          </div>

          {nsError && (
            <div class="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Namespace list failed: {nsError}
            </div>
          )}

          {!isAdmin && token && (
            <div class="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Topology endpoints are admin-only (backend requireAdmin()).
            </div>
          )}

          <div class="flex items-center justify-between mb-2 text-[11px] text-slate-500 font-mono">
            {loading ? (
              <span>loading topology…</span>
            ) : (
              <span>
                ns="{effectiveNamespace}" nodes={(graph?.nodes || []).length} edges={(graph?.edges || []).length} conn="{connState}"
              </span>
            )}
          </div>

          {error && !loading && (
            <div class="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {error}
            </div>
          )}

          <div class="flex flex-wrap gap-2 mb-3">
            {Object.keys(filters.kindEnabled).map((k) => (
              <button
                key={k}
                type="button"
                class={
                  "px-2 py-1 rounded-lg border text-[11px] font-mono " +
                  (filters.kindEnabled[k]
                    ? "bg-slate-900 text-white border-slate-900"
                    : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50")
                }
                title={`${k} (${counts[k] || 0})`}
                onClick={() =>
                  setFilters((f) => ({
                    ...f,
                    kindEnabled: { ...f.kindEnabled, [k]: !f.kindEnabled[k] },
                  }))
                }
              >
                {k} <span class="opacity-70">({counts[k] || 0})</span>
              </button>
            ))}
          </div>

          <div
            ref={containerRef}
            class="rounded-xl border border-slate-200 bg-slate-50"
            style="height: 70vh; width: 100%;"
          />
        </div>

        <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm min-w-0">
          <div class="flex items-center justify-between mb-3 gap-2 min-w-0">
            <div class="min-w-0">
              <h2 class="text-sm font-semibold text-slate-800">Node details</h2>
              <p class="text-xs text-slate-500">Click a node to inspect.</p>
            </div>
          </div>

          {!selected && <div class="text-xs text-slate-500">No node selected.</div>}

          {selected && <NodeDetails selected={selected} />}
        </div>
      </section>
    </>
  );
}

function NodeDetails({ selected }) {
  const kind = selected.kind;
  const detail = selected.detail || {};

  const isIngress = kind === "Ingress";
  const isService = kind === "Service";

  const hosts = isIngress ? (Array.isArray(detail.hosts) ? detail.hosts : []) : [];
  const paths = isIngress ? (Array.isArray(detail.paths) ? detail.paths : []) : [];

  const backendState = isService ? detail.backendState : null;

  return (
    <div class="space-y-3 text-xs min-w-0">
      <div class="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
        <div class="text-[11px] text-slate-500 font-mono break-all">{selected.id}</div>
        <div class="mt-1 flex flex-wrap gap-2 items-center">
          <span class="font-semibold text-slate-800">{selected.kind}:</span>
          <span class="font-mono text-slate-800 break-all">{selected.name}</span>
        </div>
        <div class="mt-1 text-[11px] text-slate-600 font-mono">
          status={selected.status || "-"}
          {selected.namespace ? ` ns=${selected.namespace}` : ""}
        </div>
      </div>

      {isService && (
        <div class="rounded-xl border border-slate-200 bg-white px-3 py-2">
          <div class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em] mb-2">
            Backend readiness
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <span class={"inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-mono " + badgeClassForBackend(backendState)}>
              {String(backendState || "unknown")}
            </span>
            <span class="text-[11px] text-slate-600 font-mono">
              readyPods={detail.readyPods || 0} readyEndpoints={detail.readyEndpoints || 0}
            </span>
          </div>
          {detail.backendReason && (
            <div class="mt-2 text-[11px] text-slate-600 font-mono break-all">
              reason={detail.backendReason}
            </div>
          )}
        </div>
      )}

      {isIngress && (
        <div class="rounded-xl border border-slate-200 bg-white px-3 py-2 min-w-0">
          <div class="flex items-center justify-between mb-2">
            <div class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em]">
              Hosts
            </div>
            {detail.className ? (
              <div class="text-[11px] text-slate-600 font-mono">class={detail.className}</div>
            ) : null}
          </div>

          {hosts.length === 0 ? (
            <div class="text-[11px] text-slate-500">No hosts found.</div>
          ) : (
            <div class="flex flex-col gap-2">
              {hosts.map((h) => {
                const st = summarizeIngressHostState(paths, h);
                const url = safeHostToURL(h, "/");
                const clickable = !!url && st.state === "ready";

                return (
                  <div key={h} class="flex items-center justify-between gap-2 min-w-0">
                    <div class="min-w-0">
                      <button
                        type="button"
                        class={
                          "text-left font-mono text-[11px] break-all " +
                          (clickable
                            ? "text-sky-700 hover:underline"
                            : "text-slate-400 cursor-not-allowed")
                        }
                        disabled={!clickable}
                        title={clickable ? `Open https://${h}` : `Disabled: ${st.reason || "no ready backend"}`}
                        onClick={() => {
                          if (!clickable) return;
                          const u = safeHostToURL(h, "/");
                          if (!u) return;
                          window.open(u, "_blank", "noopener,noreferrer");
                        }}
                      >
                        {h}
                      </button>
                    </div>

                    <span
                      class={
                        "shrink-0 inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-mono " +
                        badgeClassForBackend(st.state)
                      }
                      title={st.reason || ""}
                    >
                      {st.state}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          <div class="mt-3">
            <div class="text-[11px] font-semibold text-slate-800 uppercase tracking-[0.16em] mb-2">
              Paths
            </div>

            {paths.length === 0 ? (
              <div class="text-[11px] text-slate-500">No HTTP paths.</div>
            ) : (
              <div class="space-y-2">
                {paths.map((p, idx) => {
                  const st = String(p?.backendState || "unknown");
                  const url = safeHostToURL(p?.host, p?.path);
                  const clickable = !!url && String(st).toLowerCase() === "ready";

                  return (
                    <div key={idx} class="rounded-lg border border-slate-200 bg-slate-50 px-2 py-2">
                      <div class="flex items-start justify-between gap-2">
                        <div class="min-w-0">
                          <div class="font-mono text-[11px] text-slate-800 break-all">
                            {String(p?.host || "(host)")} {String(p?.path || "/")}
                          </div>
                          <div class="mt-1 font-mono text-[11px] text-slate-600 break-all">
                            svc={String(p?.service || "-")} port={String(p?.port ?? "-")}
                          </div>
                          <div class="mt-1 font-mono text-[11px] text-slate-600">
                            readyPods={p?.readyPods || 0} readyEndpoints={p?.readyEndpoints || 0}
                          </div>
                          {p?.backendReason ? (
                            <div class="mt-1 font-mono text-[11px] text-slate-500 break-all">
                              reason={String(p.backendReason)}
                            </div>
                          ) : null}
                        </div>

                        <div class="shrink-0 flex flex-col items-end gap-1">
                          <span class={"inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-mono " + badgeClassForBackend(st)}>
                            {st}
                          </span>

                          <button
                            type="button"
                            class={
                              "rounded-lg border px-2 py-1 text-[10px] font-mono " +
                              (clickable
                                ? "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
                                : "border-slate-200 bg-white text-slate-400 cursor-not-allowed")
                            }
                            disabled={!clickable}
                            title={clickable ? "Open this route" : "Disabled: backend not ready"}
                            onClick={() => {
                              if (!clickable) return;
                              window.open(url, "_blank", "noopener,noreferrer");
                            }}
                          >
                            open
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      <pre class="text-[11px] bg-slate-50 rounded-xl border border-slate-200 p-2 overflow-auto" style="max-height: 45vh;">
{JSON.stringify(detail || {}, null, 2)}
      </pre>
    </div>
  );
}

import { h } from 'preact';
import { useState, useEffect, useMemo } from 'preact/hooks';

export default function RbacPage({ token, user }) {
  const [namespaces, setNamespaces] = useState([]);
  const [namespace, setNamespace] = useState(() => {
    if (typeof window === 'undefined') return '';
    return localStorage.getItem('rbac_ns') || '';
  });

  const [subjects, setSubjects] = useState([]);
  const [roles, setRoles] = useState([]);
  const [clusterRoles, setClusterRoles] = useState([]);

  const [loadingNs, setLoadingNs] = useState(true);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [error, setError] = useState('');

  const [selectedKey, setSelectedKey] = useState('');
  const [refresh, setRefresh] = useState(0);

  // Grant/remove state
  const [roleKind, setRoleKind] = useState('Role'); // Role | ClusterRole
  const [roleName, setRoleName] = useState('');
  const [busy, setBusy] = useState(false);

  const isAdmin = (user?.role || '').toLowerCase() === 'admin';

  // Toasts
  const [toasts, setToasts] = useState([]);
  const pushToast = (type, message) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  };

  // Role info (read-only)
  const [roleInfoKey, setRoleInfoKey] = useState('');
  const [roleInfo, setRoleInfo] = useState(null);
  const [roleInfoLoading, setRoleInfoLoading] = useState(false);
  const [roleInfoError, setRoleInfoError] = useState('');

  // Helper: subject key
  const subjectKey = (s) =>
    `${s.kind || ''}|${s.name || ''}|${s.namespace || ''}`;

  // Persist namespace
  useEffect(() => {
    if (typeof window !== 'undefined' && namespace) {
      localStorage.setItem('rbac_ns', namespace);
    }
  }, [namespace]);

  // When subject or namespace changes, clear role info
  useEffect(() => {
    setRoleInfoKey('');
    setRoleInfo(null);
    setRoleInfoError('');
    setRoleInfoLoading(false);
  }, [selectedKey, namespace]);

  // Load namespaces
  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    const load = async () => {
      setLoadingNs(true);
      setError('');
      try {
        const res = await fetch('/api/rbac/namespaces', {
          headers: { Authorization: `Bearer ${token}` }
        });
        const text = await res.text();
        if (!res.ok) {
          let msg = text || 'Failed to load namespaces';
          try {
            const errObj = JSON.parse(text);
            msg = errObj.error || msg;
          } catch {}
          throw new Error(msg);
        }
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          throw new Error('Invalid JSON from /rbac/namespaces');
        }
        if (cancelled) return;
        const list = Array.isArray(data.namespaces) ? data.namespaces : [];
        setNamespaces(list);
        if (!namespace && list.length > 0) {
          setNamespace(list.includes('default') ? 'default' : list[0]);
        }
      } catch (err) {
        console.error('rbac namespaces fetch failed', err);
        if (!cancelled) {
          const msg = err.message || 'Failed to load namespaces';
          setError(msg);
          pushToast('error', msg);
        }
      } finally {
        if (!cancelled) setLoadingNs(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Load RBAC summary for namespace
  useEffect(() => {
    if (!token || !namespace) return;
    let cancelled = false;

    const load = async () => {
      setLoadingSummary(true);
      setError('');
      try {
        const res = await fetch(
          `/api/rbac/namespace/${encodeURIComponent(namespace)}/summary`,
          {
            headers: { Authorization: `Bearer ${token}` }
          }
        );
        const text = await res.text();
        if (!res.ok) {
          let msg = text || 'Failed to load RBAC summary';
          try {
            const errObj = JSON.parse(text);
            msg = errObj.error || msg;
          } catch {}
          throw new Error(msg);
        }
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          throw new Error('Invalid JSON from /rbac/namespace/.../summary');
        }
        if (cancelled) return;
        const subs = Array.isArray(data.subjects) ? data.subjects : [];
        const rs = Array.isArray(data.roles) ? data.roles : [];
        const crs = Array.isArray(data.clusterRoles) ? data.clusterRoles : [];
        setSubjects(subs);
        setRoles(rs);
        setClusterRoles(crs);

        // If selectedKey no longer exists, clear selection
        if (selectedKey && !subs.some((s) => subjectKey(s) === selectedKey)) {
          setSelectedKey('');
        }
      } catch (err) {
        console.error('rbac summary fetch failed', err);
        const msg = err.message || 'Failed to load RBAC summary';
        setError(msg);
        pushToast('error', msg);
      } finally {
        if (!cancelled) setLoadingSummary(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [token, namespace, refresh]);

  const selectedSubject = useMemo(
    () => subjects.find((s) => subjectKey(s) === selectedKey) || null,
    [subjects, selectedKey]
  );

  // Set of roleKind:roleName already bound to the selected subject in this namespace
  const existingForSelected = useMemo(() => {
    if (!selectedSubject) return new Set();
    const s = new Set();
    (selectedSubject.bindings || []).forEach((b) => {
      const kind = (b.roleKind || 'Role').toString();
      const name = (b.roleName || '').toString();
      s.add(`${kind}:${name}`);
    });
    return s;
  }, [selectedSubject]);

  // Names of roles/clusterRoles available to grant
  const availableRoleNames = useMemo(() => {
    const src = roleKind === 'ClusterRole' ? clusterRoles : roles;
    const existing = existingForSelected;

    const names = src
      .map((r) => (r.name || r.Name || r).toString())
      .filter((name) => {
        // Hide dangerous/system roles from UI selection
        if (name.startsWith('system:')) return false;
        if (name === 'cluster-admin') return false;
        return true;
      })
      .filter((name) => !existing.has(`${roleKind}:${name}`));

    return names;
  }, [roleKind, roles, clusterRoles, existingForSelected]);

  // Grant role to selected subject
  const handleGrant = async () => {
    if (!isAdmin) {
      pushToast('error', 'Only admin users can modify RBAC.');
      return;
    }
    if (!namespace || !selectedSubject) {
      pushToast('error', 'Select a namespace and a subject first.');
      return;
    }
    if (!roleName) {
      pushToast('error', 'Select a role to grant.');
      return;
    }

    setBusy(true);
    setError('');
    try {
      const payload = {
        namespace,
        subjectKind: selectedSubject.kind,
        subjectName: selectedSubject.name,
        subjectNamespace: selectedSubject.namespace || namespace,
        roleKind,
        roleName
      };

      const res = await fetch('/api/rbac/binding/add', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      const text = await res.text();
      if (!res.ok) {
        let msg = text || 'Failed to grant role';
        try {
          const errObj = JSON.parse(text);
          msg = errObj.error || msg;
        } catch {}
        throw new Error(msg);
      }

      pushToast('success', text || 'Role granted');
      setRefresh((r) => r + 1);
      setRoleName('');
    } catch (err) {
      console.error('rbac grant failed', err);
      const msg = err.message || 'Failed to grant role';
      setError(msg);
      pushToast('error', msg);
    } finally {
      setBusy(false);
    }
  };

  // Remove specific binding from selected subject
  const handleRemoveBinding = async (binding) => {
    if (!isAdmin) {
      pushToast('error', 'Only admin users can modify RBAC.');
      return;
    }
    if (!namespace || !selectedSubject) return;

    setBusy(true);
    setError('');
    try {
      const payload = {
        namespace,
        subjectKind: selectedSubject.kind,
        subjectName: selectedSubject.name,
        subjectNamespace: selectedSubject.namespace || namespace,
        roleKind: binding.roleKind,
        roleName: binding.roleName
      };

      const res = await fetch('/api/rbac/binding/remove', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      const text = await res.text();
      if (!res.ok) {
        let msg = text || 'Failed to remove role';
        try {
          const errObj = JSON.parse(text);
          msg = errObj.error || msg;
        } catch {}
        throw new Error(msg);
      }

      pushToast('success', text || 'Role removed');
      setRefresh((r) => r + 1);
    } catch (err) {
      console.error('rbac remove failed', err);
      const msg = err.message || 'Failed to remove role';
      setError(msg);
      pushToast('error', msg);
    } finally {
      setBusy(false);
    }
  };

  // Show role rules for a binding (toggle)
  const handleShowRoleInfo = async (kind, name) => {
    const k = (kind || 'Role').toString();
    const n = (name || '').toString();
    if (!n) return;

    // Build a unique key; for Role we also bake in namespace
    const key = `${k}:${k === 'Role' ? namespace : ''}:${n}`;

    // Toggle off if same
    if (key === roleInfoKey) {
      setRoleInfoKey('');
      setRoleInfo(null);
      setRoleInfoError('');
      setRoleInfoLoading(false);
      return;
    }

    if (k === 'Role' && !namespace) {
      pushToast('error', 'Namespace is required to load Role rules.');
      return;
    }

    setRoleInfoKey(key);
    setRoleInfo(null);
    setRoleInfoError('');
    setRoleInfoLoading(true);

    try {
      const params = new URLSearchParams();
      params.set('kind', k);
      params.set('name', n);
      if (k === 'Role') {
        params.set('namespace', namespace);
      }

      const res = await fetch(`/api/rbac/role?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const text = await res.text();
      if (!res.ok) {
        let msg = text || 'Failed to load role rules';
        try {
          const errObj = JSON.parse(text);
          msg = errObj.error || msg;
        } catch {}
        throw new Error(msg);
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error('Invalid JSON from /rbac/role');
      }

      setRoleInfo(data);
    } catch (err) {
      console.error('rbac role info failed', err);
      const msg = err.message || 'Failed to load role rules';
      setRoleInfoError(msg);
      pushToast('error', msg);
    } finally {
      setRoleInfoLoading(false);
    }
  };

  return (
    <>
      <section class="grid gap-4 lg:grid-cols-[2fr,1.3fr]">
        {/* Left: namespace + subjects list */}
        <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div class="flex flex-wrap items-center justify-between gap-3 mb-3">
            <div>
              <h2 class="text-sm font-semibold text-slate-800">
                RBAC – Namespace subjects
              </h2>
              <p class="text-xs text-slate-500">
                Select a namespace to see users/service accounts and their roles.
              </p>
            </div>
            <div class="flex flex-wrap items-center gap-2 text-xs">
              <select
                class="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700"
                value={namespace}
                onChange={(e) => {
                  setNamespace(e.target.value);
                  setSelectedKey('');
                  setSubjects([]);
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
          </div>

          <div class="flex items-center justify-between mb-2 text-[11px] text-slate-500 font-mono">
            {loadingNs ? (
              <span>loading namespaces…</span>
            ) : (
              <span>
                ns={namespace || '-'} subjects={subjects.length}
              </span>
            )}
            {loadingSummary && namespace && <span>loading RBAC…</span>}
          </div>

          {error && (
            <div class="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {error}
            </div>
          )}

          {!namespace && !loadingNs && (
            <div class="text-xs text-slate-500">
              Select a namespace to see RBAC subjects.
            </div>
          )}

          {namespace && !loadingSummary && subjects.length === 0 && !error && (
            <div class="text-xs text-slate-500">
              No RoleBindings found in this namespace.
            </div>
          )}

          {namespace && subjects.length > 0 && (
            <div class="overflow-x-auto">
              <table class="min-w-full text-xs border-separate border-spacing-y-[3px]">
                <thead>
                  <tr class="text-[11px] text-slate-500">
                    <th class="text-left font-medium px-2 py-1">Kind</th>
                    <th class="text-left font-medium px-2 py-1">Name</th>
                    <th class="text-left font-medium px-2 py-1">SA Namespace</th>
                    <th class="text-left font-medium px-2 py-1">Bindings</th>
                  </tr>
                </thead>
                <tbody>
                  {subjects.map((s) => {
                    const key = subjectKey(s);
                    const active = key === selectedKey;
                    return (
                      <tr
                        key={key}
                        class={
                          'bg-slate-50 hover:bg-slate-100 cursor-pointer ' +
                          (active
                            ? 'outline outline-1 outline-emerald-400/70'
                            : '')
                        }
                        onClick={() => setSelectedKey(key)}
                      >
                        <td class="px-2 py-1 align-top text-[11px] text-slate-600 font-mono">
                          {s.kind}
                        </td>
                        <td class="px-2 py-1 align-top">
                          <div class="font-mono text-[11px] text-slate-800">
                            {s.name}
                          </div>
                        </td>
                        <td class="px-2 py-1 align-top text-[11px] text-slate-600 font-mono">
                          {s.kind === 'ServiceAccount'
                            ? s.namespace || namespace
                            : '-'}
                        </td>
                        <td class="px-2 py-1 align-top">
                          <div class="flex flex-wrap gap-1">
                            {(s.bindings || []).map((b) => (
                              <span
                                key={`${b.bindingName}-${b.roleKind}-${b.roleName}`}
                                class="inline-flex items-center rounded-full border border-slate-200 bg-slate-100 px-2 py-0.5 text-[10px] font-mono text-slate-700"
                              >
                                {b.roleKind}:{b.roleName}
                              </span>
                            ))}
                            {(!s.bindings || s.bindings.length === 0) && (
                              <span class="text-[10px] text-slate-400">
                                no bindings
                              </span>
                            )}
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

        {/* Right: subject detail + grant/remove + role rules */}
        <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div class="flex items-center justify-between mb-3">
            <div>
              <h2 class="text-sm font-semibold text-slate-800">
                Subject details
              </h2>
              <p class="text-xs text-slate-500">
                View and adjust RoleBindings for the selected subject.
              </p>
            </div>
            {selectedSubject && (
              <div class="text-[11px] text-slate-500 font-mono text-right">
                {selectedSubject.kind}/{selectedSubject.name}
                {selectedSubject.kind === 'ServiceAccount' && (
                  <>
                    <br />
                    ns={selectedSubject.namespace || namespace}
                  </>
                )}
              </div>
            )}
          </div>

          {!selectedSubject && (
            <div class="text-xs text-slate-500">
              No subject selected. Click a row on the left to manage its RBAC.
            </div>
          )}

          {selectedSubject && (
            <div class="space-y-4 text-xs">
              {/* Current bindings */}
              <div class="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                <div class="flex items-center justify-between mb-1">
                  <div class="text-[11px] text-slate-600 font-mono">
                    bindings={selectedSubject.bindings?.length || 0}
                  </div>
                  <div class="text-[11px] text-slate-500">
                    mode={isAdmin ? 'admin' : 'readonly'}
                  </div>
                </div>

                {(selectedSubject.bindings || []).length === 0 && (
                  <div class="text-[11px] text-slate-500">
                    This subject currently has no RoleBindings in namespace{' '}
                    <span class="font-mono">{namespace}</span>.
                  </div>
                )}

                {(selectedSubject.bindings || []).length > 0 && (
                  <div class="space-y-1">
                    {selectedSubject.bindings.map((b) => (
                      <div
                        key={`${b.bindingName}-${b.roleKind}-${b.roleName}`}
                        class="flex items-center justify-between gap-2"
                      >
                        <div class="flex flex-wrap items-center gap-2">
                          <span class="inline-flex items-center rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-mono text-slate-700">
                            {b.roleKind}:{b.roleName}
                          </span>
                          <span class="text-[10px] text-slate-400 font-mono">
                            ({b.bindingName})
                          </span>
                        </div>
                        <div class="flex items-center gap-1">
                          <button
                            type="button"
                            class="rounded-lg border border-slate-300 bg-white px-2 py-1 text-[10px] text-slate-700 hover:bg-slate-100"
                            onClick={() =>
                              handleShowRoleInfo(
                                b.roleKind || 'Role',
                                b.roleName
                              )
                            }
                          >
                            Rules
                          </button>
                          {isAdmin && (
                            <button
                              type="button"
                              class="rounded-lg border border-rose-300 bg-white px-2 py-1 text-[10px] text-rose-700 hover:bg-rose-50 disabled:opacity-50"
                              onClick={() => handleRemoveBinding(b)}
                              disabled={busy}
                            >
                              Remove
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Role rules panel */}
              {roleInfoKey && (
                <div class="rounded-xl border border-slate-200 bg-white px-3 py-2">
                  <div class="flex items-center justify-between mb-1">
                    <div>
                      <div class="text-[11px] font-semibold text-slate-800">
                        Role rules
                      </div>
                      {roleInfo && (
                        <div class="text-[11px] text-slate-500 font-mono">
                          {roleInfo.kind}{' '}
                          {roleInfo.namespace
                            ? `${roleInfo.namespace}/`
                            : ''}
                          {roleInfo.name}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      class="rounded-lg border border-slate-300 bg-white px-2 py-1 text-[10px] text-slate-600 hover:bg-slate-100"
                      onClick={() => {
                        setRoleInfoKey('');
                        setRoleInfo(null);
                        setRoleInfoError('');
                        setRoleInfoLoading(false);
                      }}
                    >
                      Close
                    </button>
                  </div>

                  {roleInfoLoading && (
                    <div class="text-[11px] text-slate-500 font-mono">
                      loading role rules…
                    </div>
                  )}

                  {roleInfoError && !roleInfoLoading && (
                    <div class="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-700">
                      {roleInfoError}
                    </div>
                  )}

                  {roleInfo &&
                    Array.isArray(roleInfo.rules) &&
                    roleInfo.rules.length > 0 &&
                    !roleInfoLoading &&
                    !roleInfoError && (
                      <div class="mt-2 max-h-56 overflow-auto rounded-lg border border-slate-200 bg-slate-50">
                        <table class="min-w-full text-[11px]">
                          <thead class="bg-slate-100">
                            <tr>
                              <th class="px-2 py-1 text-left border-b border-slate-200">
                                API groups
                              </th>
                              <th class="px-2 py-1 text-left border-b border-slate-200">
                                Resources / URLs
                              </th>
                              <th class="px-2 py-1 text-left border-b border-slate-200">
                                Verbs
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {roleInfo.rules.map((r, idx) => (
                              <tr key={idx} class="align-top">
                                <td class="px-2 py-1 border-b border-slate-200 align-top">
                                  <div class="font-mono text-[10px] text-slate-700">
                                    {(r.apiGroups || r.APIGroups || ['']).join(
                                      ', '
                                    ) || '(core)'}
                                  </div>
                                </td>
                                <td class="px-2 py-1 border-b border-slate-200 align-top">
                                  <div class="font-mono text-[10px] text-slate-700">
                                    {r.nonResourceURLs &&
                                    r.nonResourceURLs.length > 0
                                      ? `nonResourceURLs: ${r.nonResourceURLs.join(
                                          ', '
                                        )}`
                                      : (r.resources || []).join(', ')}
                                    {r.resourceNames &&
                                      r.resourceNames.length > 0 && (
                                        <div class="mt-0.5 text-slate-500">
                                          names: {r.resourceNames.join(', ')}
                                        </div>
                                      )}
                                  </div>
                                </td>
                                <td class="px-2 py-1 border-b border-slate-200 align-top">
                                  <div class="font-mono text-[10px] text-slate-700">
                                    {(r.verbs || []).join(', ')}
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                  {roleInfo &&
                    (!roleInfo.rules ||
                      !Array.isArray(roleInfo.rules) ||
                      roleInfo.rules.length === 0) &&
                    !roleInfoLoading &&
                    !roleInfoError && (
                      <div class="text-[11px] text-slate-500">
                        This role has no rules.
                      </div>
                    )}
                </div>
              )}

              {/* Grant new role */}
              <div class="rounded-xl border border-slate-200 bg-white px-3 py-2 flex flex-col gap-2">
                <div class="text-[11px] font-semibold text-slate-800">
                  Grant additional role
                </div>
                {!isAdmin && (
                  <div class="text-[11px] text-slate-500">
                    You are logged in as a non-admin user; RBAC changes are
                    read-only in this UI.
                  </div>
                )}

                {isAdmin && (
                  <>
                    <div class="flex flex-wrap items-center gap-2 text-[11px]">
                      <select
                        class="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-700"
                        value={roleKind}
                        onChange={(e) => {
                          setRoleKind(e.target.value);
                          setRoleName('');
                        }}
                      >
                        <option value="Role">Role (namespaced)</option>
                        <option value="ClusterRole">
                          ClusterRole (cluster-wide)
                        </option>
                      </select>

                      <select
                        class="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-700 min-w-[160px]"
                        value={roleName}
                        onChange={(e) => setRoleName(e.target.value)}
                      >
                        <option value="">Select role…</option>
                        {availableRoleNames.map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </div>

                    {availableRoleNames.length === 0 && (
                      <div class="text-[10px] text-slate-400">
                        No additional {roleKind} entries available to grant.
                        Define more Roles/ClusterRoles in the cluster (via
                        YAML/Git) to offer additional permission profiles.
                      </div>
                    )}

                    <div class="flex items-center gap-2 text-[11px] mt-1">
                      <button
                        type="button"
                        class="rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                        onClick={handleGrant}
                        disabled={busy || !roleName}
                      >
                        {busy ? 'Working…' : 'Grant role'}
                      </button>
                      <span class="text-[10px] text-slate-400">
                        This will create or update a RoleBinding in namespace{' '}
                        <span class="font-mono">{namespace}</span>.
                      </span>
                    </div>
                  </>
                )}
              </div>
            </div>
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

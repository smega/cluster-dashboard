import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import Router from 'preact-router';
import { Link } from 'preact-router/match';

import LoginPage from './LoginPage.jsx';
import OverviewPage from './pages/OverviewPage.jsx';
import PodsPage from './pages/PodsPage.jsx';
import DeploymentsPage from './pages/DeploymentsPage.jsx';
import RbacPage from './pages/RbacPage.jsx';
import ServicesPage from './pages/ServicesPage.jsx';
import IngressesPage from './pages/IngressesPage.jsx';
import VolumesPage from './pages/VolumesPage.jsx';
import JobsTab from "./pages/JobsPage.jsx";
import ConfigPage from './pages/ConfigPage.jsx';
import AutoscalingPage from './pages/HpaPage.jsx';
import EventsPage from './pages/EventsPage.jsx';
import StatefulSetsPage from './pages/StatefulSetsPage.jsx';
import StoragePage from './pages/StoragePage.jsx';
import NodesPage from './pages/NodesPage.jsx';
import NetworkPoliciesPage from './pages/NetworkPoliciesPage.jsx';
import ImageProvenancePage from './pages/ImageProvenancePage.jsx';
import CostWasteSignalsPage from './pages/CostWasteSignalsPage.jsx';
import Topology from './pages/TopologyPage.jsx';

const API_BASE = '';

export default function App() {
  const [token, setToken] = useState(null);
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const stored = localStorage.getItem('auth_token');
    if (!stored) {
      setChecking(false);
      return;
    }

    const verify = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/me`, {
          headers: { Authorization: `Bearer ${stored}` }
        });

        if (!res.ok) {
          localStorage.removeItem('auth_token');
          setToken(null);
          setUser(null);
        } else {
          const data = await res.json();
          setToken(stored);
          setUser(data);
        }
      } catch (err) {
        console.error('me check failed', err);
        localStorage.removeItem('auth_token');
        setToken(null);
        setUser(null);
      } finally {
        setChecking(false);
      }
    };

    verify();
  }, []);

  const handleLoggedIn = (newToken) => {
    localStorage.setItem('auth_token', newToken);
    setToken(newToken);

    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/me`, {
          headers: { Authorization: `Bearer ${newToken}` }
        });
        if (res.ok) {
          const data = await res.json();
          setUser(data);
        }
      } catch (err) {
        console.error('me after login failed', err);
      }
    })();
  };

  const handleLogout = () => {
    localStorage.removeItem('auth_token');
    setToken(null);
    setUser(null);
  };

  if (checking) {
    return (
      <div class="min-h-screen flex items-center justify-center bg-slate-100 text-slate-900">
        <div class="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs text-slate-500 shadow-sm font-mono">
          checking session…
        </div>
      </div>
    );
  }

  if (!token) {
    return <LoginPage onLoggedIn={handleLoggedIn} />;
  }

  return (
    <div class="min-h-screen bg-slate-100 text-slate-900 flex flex-col">
      {/* Top bar */}
      <header class="border-b border-slate-200 bg-white/80 backdrop-blur px-6 py-3 flex items-center justify-between shadow-sm">
        <div class="flex items-center gap-3">
          <div class="h-8 w-8 rounded-xl bg-emerald-500/10 border border-emerald-500/40 flex items-center justify-center">
            <span class="text-xs font-mono text-emerald-700">KD</span>
          </div>
          <div>
            <h1 class="text-base font-semibold text-slate-900">
              Cluster Dashboard
            </h1>
            {user && (
              <p class="text-xs text-slate-500 flex items-center gap-2">
                <span class="font-mono text-[11px]">
                  user={user.email}
                </span>
                {user.role && (
                  <span class="inline-flex items-center rounded-full bg-slate-100 border border-slate-200 px-2 py-0.5 text-[11px] font-mono text-slate-600">
                    role={user.role}
                  </span>
                )}
              </p>
            )}
          </div>
        </div>

        {/* Right side: Logout */}
        <div class="flex items-center gap-2">
          <button
            class="px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 shadow-sm"
            onClick={handleLogout}
            title="Log out"
          >
            Log out
          </button>
        </div>
      </header>

      {/* Ops Nav */}
      <div class="px-6 pt-4 bg-slate-100 border-b border-slate-200">
        <div class="inline-flex flex-wrap items-center gap-1 gap-y-1 rounded-2xl bg-slate-200/80 p-1 text-xs font-medium">
          <NavLink href="/" exact>Overview</NavLink>
          <NavLink href="/deployments">Deployments</NavLink>
          <NavLink href="/pods">Pods</NavLink>
          <NavLink href="/services">Services</NavLink>
          <NavLink href="/ingresses">Ingresses</NavLink>
          <NavLink href="/volumes">Volumes</NavLink>
          <NavLink href="/rbac">RBAC</NavLink>
          <NavLink href="/jobs">Jobs</NavLink>
          <NavLink href="/config">Config</NavLink>
          <NavLink href="/autoscaling">Autoscaling</NavLink>
          <NavLink href="/events">Events</NavLink>
          <NavLink href="/statefulsets">StatefulSets</NavLink>
          <NavLink href="/storage">Storage</NavLink>
          <NavLink href="/nodes">Nodes</NavLink>
          <NavLink href="/network-policies">Network Policies</NavLink>
          <NavLink href="/image-provenance">Image Provenance</NavLink>
          <NavLink href="/cost-waste-signals">Cost Waste Signals</NavLink>
          <NavLink href="/topology">Topology</NavLink>
        </div>
      </div>

      {/* Routed content */}
      <main class="flex-1 px-6 py-5">
        <Router>
          <OverviewPage path="/" user={user} token={token} />
          <DeploymentsPage path="/deployments" user={user} token={token} />
          <PodsPage path="/pods" user={user} token={token} />
          <ServicesPage path="/services" user={user} token={token} />
          <IngressesPage path="/ingresses" user={user} token={token} />
          <VolumesPage path="/volumes" user={user} token={token} />
          <RbacPage path="/rbac" user={user} token={token} />
          <JobsTab path="/jobs" user={user} token={token} />
          <ConfigPage path="/config" user={user} token={token} />
          <AutoscalingPage path="/autoscaling" user={user} token={token} />
          <EventsPage path="/events" user={user} token={token} />
          <StatefulSetsPage path="/statefulsets" user={user} token={token} />
          <StoragePage path="/storage" user={user} token={token} />
          <NodesPage path="/nodes" user={user} token={token} />
          <NetworkPoliciesPage path="/network-policies" user={user} token={token} />
          <ImageProvenancePage path="/image-provenance" user={user} token={token} />
          <CostWasteSignalsPage path="/cost-waste-signals" user={user} token={token} />
          <Topology path="/topology" user={user} token={token} />
        </Router>
      </main>
    </div>
  );
}

function NavLink({ href, exact, children }) {
  return (
    <Link
      href={href}
      activeClassName="bg-white text-slate-900 shadow-sm border border-slate-200"
      className="px-3 py-1.5 rounded-full transition-colors text-slate-600 hover:text-slate-900"
      exact={exact}
    >
      {children}
    </Link>
  );
}


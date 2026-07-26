import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useAuth, useUi } from './store';
import { onUnauthorized } from './api';
import { Toaster, ConfirmHost, Spinner } from './components/ui';
import { Sidebar } from './components/Sidebar';
import Login from './pages/Login';
import Chat from './pages/Chat';
import Images from './pages/Images';
import Settings from './pages/Settings';
import Admin from './pages/admin/Admin';

function Shell() {
  const { user, loaded } = useAuth();
  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const setSidebarOpen = useUi((s) => s.setSidebarOpen);
  const loc = useLocation();

  if (!loaded) {
    return <div className="flex h-full items-center justify-center"><Spinner className="h-6 w-6" /></div>;
  }
  if (!user) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;

  return (
    <div className="flex h-full overflow-hidden">
      <Sidebar />
      {sidebarOpen && (
        <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={() => setSidebarOpen(false)} />
      )}
      <main className="relative flex min-w-0 flex-1 flex-col">
        <Outlet />
      </main>
    </div>
  );
}

function AdminGate() {
  const { user } = useAuth();
  if (user?.role !== 'admin') return <Navigate to="/" replace />;
  return <Admin />;
}

export default function App() {
  const refresh = useAuth((s) => s.refresh);

  useEffect(() => {
    onUnauthorized.handler = () => {
      const { user } = useAuth.getState();
      if (user) useAuth.setState({ user: null });
    };
    refresh();
  }, [refresh]);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<Shell />}>
          <Route path="/" element={<Chat />} />
          <Route path="/chat/:id" element={<Chat />} />
          <Route path="/images" element={<Images />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/admin/*" element={<AdminGate />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Toaster />
      <ConfirmHost />
    </BrowserRouter>
  );
}

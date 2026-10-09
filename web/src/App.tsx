import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Megaphone, X } from 'lucide-react';
import { useAnnouncement, useAuth, useHtmlPreview, useUi, useWorkspacePanel } from './store';
import { t } from './i18n';
import { onUnauthorized } from './api';
import { startRealtime, stopRealtime } from './realtime';
import { Toaster, ConfirmHost, Spinner } from './components/ui';
import { Sidebar } from './components/Sidebar';
import { HtmlPreviewPanel } from './components/HtmlPreviewPanel';
import { WorkspacePanel } from './components/WorkspacePanel';
import { LightboxHost } from './components/Lightbox';
import { ProjectDocHost } from './components/ProjectDocDialog';
import { notifyNavigate } from './notify';
import type { SettingsTab } from './store';
import Login from './pages/Login';
import ErrorReset from './pages/ErrorReset';
import Chat from './pages/Chat';
import Images from './pages/Images';
import Gallery from './pages/Gallery';
import NaiStudio from './pages/NaiStudio';
import ProjectPage from './pages/Project';
import ProjectsPage from './pages/Projects';
import Ppt from './pages/Ppt';
import Ocr from './pages/Ocr';
import Translate from './pages/Translate';
import Bookmarks from './pages/Bookmarks';
import { SettingsDialog } from './components/SettingsDialog';
import Admin from './pages/admin/Admin';

function AnnouncementBanner() {
  const { text, updatedAt, dismissedAt, load, dismiss } = useAnnouncement();
  useEffect(() => { void load().catch(() => { /* banner just stays hidden */ }); }, [load]);
  if (!text || updatedAt === dismissedAt) return null;
  return (
    <div className="flex items-start gap-2 border-b border-line bg-acc/10 px-4 py-2 text-[13px] text-tx">
      <Megaphone size={15} className="mt-0.5 shrink-0 text-acc" />
      <p className="min-w-0 flex-1 whitespace-pre-wrap leading-relaxed">{text}</p>
      <button
        title={t('关闭公告(内容更新后会再次显示)')}
        className="shrink-0 cursor-pointer rounded-sm p-0.5 text-tx3 transition-colors hover:bg-bg2 hover:text-tx"
        onClick={dismiss}
      >
        <X size={14} />
      </button>
    </div>
  );
}

function Shell() {
  const { user, loaded } = useAuth();
  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const setSidebarOpen = useUi((s) => s.setSidebarOpen);
  const loc = useLocation();
  const nav = useNavigate();
  const closePreview = useHtmlPreview((s) => s.close);

  // A clicked system notification lands on the chat it was about.
  useEffect(() => {
    notifyNavigate.handler = (path) => nav(path);
    return () => { notifyNavigate.handler = null; };
  }, [nav]);

  // A popped-out HTML preview belongs to the page it came from.
  useEffect(() => { closePreview(); }, [loc.pathname, closePreview]);
  // The 工作区 panel follows chats (the chat page re-points it); anywhere
  // else it has nothing to show.
  useEffect(() => {
    if (!loc.pathname.startsWith('/chat/')) useWorkspacePanel.getState().close();
  }, [loc.pathname]);

  // Server-pushed cache invalidation lives for exactly as long as the session.
  const userId = user?.id ?? null;
  useEffect(() => {
    if (!userId) return;
    startRealtime();
    return () => stopRealtime();
  }, [userId]);

  if (!loaded) {
    return <div className="flex h-full items-center justify-center text-tx3"><Spinner className="h-6 w-6" /></div>;
  }
  if (!user) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;

  return (
    <div className="flex h-full overflow-hidden bg-bg0">
      <Sidebar />
      {sidebarOpen && (
        <div className="fixed inset-0 z-30 bg-scrim md:hidden" onClick={() => setSidebarOpen(false)} />
      )}
      {/* Content sits on the raised white surface; the grey canvas stays behind
          the rail, which is what separates navigation from work. */}
      <main className="relative flex min-w-0 flex-1 flex-col bg-bg1">
        <AnnouncementBanner />
        <Outlet />
      </main>
      <HtmlPreviewPanel />
      <WorkspacePanel />
      <SettingsDialog />
      <LightboxHost />
      <ProjectDocHost />
    </div>
  );
}

// /settings used to be a page. Old links (and muscle memory) still land
// somewhere sensible: open the dialog over the chat page. `?tab=` picks the
// section, e.g. /settings?tab=devices.
const SETTINGS_TABS: SettingsTab[] = ['account', 'chat', 'appearance', 'devices', 'usage', 'storage'];
function SettingsOpener() {
  const loc = useLocation();
  const openSettings = useUi((s) => s.openSettings);
  useEffect(() => {
    const tab = new URLSearchParams(loc.search).get('tab') as SettingsTab | null;
    openSettings(tab && SETTINGS_TABS.includes(tab) ? tab : undefined);
  }, [loc.search, openSettings]);
  return <Navigate to="/" replace />;
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
        {/* Outside Shell: must render even when stale cookies break auth. */}
        <Route path="/error" element={<ErrorReset />} />
        <Route element={<Shell />}>
          <Route path="/" element={<Chat />} />
          <Route path="/chat/:id" element={<Chat />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:id" element={<ProjectPage />} />
          <Route path="/images" element={<Images />} />
          <Route path="/images/gallery" element={<Gallery />} />
          <Route path="/images/nai" element={<NaiStudio />} />
          <Route path="/ppt" element={<Ppt />} />
          <Route path="/ocr" element={<Ocr />} />
          <Route path="/translate" element={<Translate />} />
          <Route path="/bookmarks" element={<Bookmarks />} />
          <Route path="/settings" element={<SettingsOpener />} />
          <Route path="/admin/*" element={<AdminGate />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Toaster />
      <ConfirmHost />
    </BrowserRouter>
  );
}

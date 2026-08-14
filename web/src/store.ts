import { create } from 'zustand';
import { api } from './api';
import type { Bootstrap, ChatSummary, McpServerInfo, ModelInfo, Project, User } from './types';
import type { ComposerSettings, PendingImage } from './components/Composer';

// ---- theme ----
// Light is the product default; `html.dark` is the opt-in override. First-time
// visitors inherit the OS preference instead of being forced into one theme.
export type Theme = 'dark' | 'light';

const THEME_KEY = 'cat-theme';

function applyTheme(t: Theme) {
  document.documentElement.classList.toggle('dark', t === 'dark');
  localStorage.setItem(THEME_KEY, t);
}

function initialTheme(): Theme {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'dark' || saved === 'light') return saved;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

interface UiState {
  theme: Theme;
  sidebarOpen: boolean;
  setTheme(t: Theme): void;
  setSidebarOpen(v: boolean): void;
}

export const useUi = create<UiState>((set) => {
  const theme = initialTheme();
  applyTheme(theme);
  return {
    theme,
    sidebarOpen: window.innerWidth > 900,
    setTheme(t) { applyTheme(t); set({ theme: t }); },
    setSidebarOpen(v) { set({ sidebarOpen: v }); },
  };
});

// ---- auth ----
interface AuthState {
  user: User | null;
  bootstrap: Bootstrap | null;
  loaded: boolean;
  refresh(): Promise<void>;
  setUser(u: User | null): void;
  logout(): Promise<void>;
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  bootstrap: null,
  loaded: false,
  async refresh() {
    const bootstrap = await api.get<Bootstrap>('/api/auth/bootstrap').catch(() => null);
    let user: User | null = null;
    try {
      const r = await api.get<{ user: User }>('/api/auth/me');
      user = r.user;
    } catch { /* not logged in */ }
    set({ user, bootstrap, loaded: true });
  },
  setUser(u) { set({ user: u }); },
  async logout() {
    await api.post('/api/auth/logout').catch(() => { /* ignore */ });
    set({ user: null });
  },
}));

// ---- chats list (sidebar) ----
interface ChatsState {
  chats: ChatSummary[];
  loaded: boolean;
  load(): Promise<void>;
  upsert(c: ChatSummary): void;
  patch(id: string, p: Partial<ChatSummary>): void;
  remove(id: string): void;
}

export const useChats = create<ChatsState>((set, get) => ({
  chats: [],
  loaded: false,
  async load() {
    const r = await api.get<{ chats: ChatSummary[] }>('/api/chats');
    set({ chats: r.chats, loaded: true });
  },
  upsert(c) {
    const rest = get().chats.filter((x) => x.id !== c.id);
    set({ chats: [c, ...rest] });
  },
  patch(id, p) {
    set({ chats: get().chats.map((c) => (c.id === id ? { ...c, ...p } : c)) });
  },
  remove(id) {
    set({ chats: get().chats.filter((c) => c.id !== id) });
  },
}));

// ---- projects (sidebar cache) ----
interface ProjectsState {
  projects: Project[];
  loaded: boolean;
  load(force?: boolean): Promise<void>;
  upsert(p: Project): void;
  remove(id: string): void;
}

export const useProjects = create<ProjectsState>((set, get) => ({
  projects: [],
  loaded: false,
  async load(force) {
    if (get().loaded && !force) return;
    const r = await api.get<{ projects: Project[] }>('/api/projects');
    set({ projects: r.projects, loaded: true });
  },
  upsert(p) {
    const rest = get().projects.filter((x) => x.id !== p.id);
    set({ projects: [p, ...rest] });
  },
  remove(id) {
    set({ projects: get().projects.filter((p) => p.id !== id) });
  },
}));

// The composer remembers the last explicitly chosen model across pages.
export const LAST_MODEL_KEY = 'cat-last-model';

// One-shot handoff: the project page's composer stashes its full payload here,
// then navigates to `/?project=<id>`; the chat page consumes it and auto-sends.
// Module-level (not router state) so back-navigation can never replay the send.
export interface ChatHandoffPayload {
  text: string;
  images: PendingImage[];
  modelId: string | null;
  settings: ComposerSettings;
  mcpSelected: string[];
}
export const chatHandoff: { payload: ChatHandoffPayload | null } = { payload: null };

// ---- models & mcp servers (shared caches) ----
interface ModelsState {
  models: ModelInfo[];
  loaded: boolean;
  load(force?: boolean): Promise<void>;
}

export const useModels = create<ModelsState>((set, get) => ({
  models: [],
  loaded: false,
  async load(force) {
    if (get().loaded && !force) return;
    const r = await api.get<ModelInfo[]>('/api/models');
    set({ models: Array.isArray(r) ? r : [], loaded: true });
  },
}));

interface McpState {
  servers: McpServerInfo[];
  loaded: boolean;
  load(force?: boolean): Promise<void>;
}

/** Remembered 联网搜索 toggle preference; '0' = user turned it off. */
export const searchPrefKey = (userId?: string) => `cat-search-on:${userId ?? 'anon'}`;

export const useMcp = create<McpState>((set, get) => ({
  servers: [],
  loaded: false,
  async load(force) {
    if (get().loaded && !force) return;
    const r = await api.get<{ servers: McpServerInfo[] } | McpServerInfo[]>('/api/mcp/servers');
    const servers = Array.isArray(r) ? r : r.servers ?? [];
    set({ servers, loaded: true });
  },
}));

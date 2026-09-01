import { create } from 'zustand';
import { api } from './api';
import type { Bootstrap, ChatSummary, McpServerInfo, ModelInfo, Project, User } from './types';
import type { ComposerSettings, PendingAttachment } from './components/Composer';

// ---- theme ----
// Three-way: follow the OS (default), or pin light / dark. Only the *mode* is
// persisted; the effective theme is re-derived from prefers-color-scheme and
// tracks it live, so an iPhone flipping to dark at sunset flips the app too.
// index.html applies the same rule before first paint to avoid a flash.
export type Theme = 'dark' | 'light';
export type ThemeMode = Theme | 'system';

const THEME_KEY = 'cat-theme';
const darkQuery = window.matchMedia?.('(prefers-color-scheme: dark)') ?? null;

function systemTheme(): Theme {
  return darkQuery?.matches ? 'dark' : 'light';
}

function resolveTheme(mode: ThemeMode): Theme {
  return mode === 'system' ? systemTheme() : mode;
}

function applyTheme(t: Theme) {
  document.documentElement.classList.toggle('dark', t === 'dark');
}

function initialThemeMode(): ThemeMode {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'dark' || saved === 'light') return saved;
  return 'system';
}

export type SettingsTab = 'account' | 'chat' | 'appearance' | 'devices' | 'usage';

interface UiState {
  /** Effective theme — what is on screen right now. */
  theme: Theme;
  /** What the user chose; 'system' follows the OS. */
  themeMode: ThemeMode;
  sidebarOpen: boolean;
  /** The claude.ai-style settings dialog: open state plus the active section. */
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  setThemeMode(mode: ThemeMode): void;
  setSidebarOpen(v: boolean): void;
  openSettings(tab?: SettingsTab): void;
  closeSettings(): void;
  setSettingsTab(tab: SettingsTab): void;
}

export const useUi = create<UiState>((set, get) => {
  const themeMode = initialThemeMode();
  const theme = resolveTheme(themeMode);
  applyTheme(theme);
  // OS switched: only matters while following it.
  darkQuery?.addEventListener('change', () => {
    if (get().themeMode !== 'system') return;
    const next = systemTheme();
    applyTheme(next);
    set({ theme: next });
  });
  return {
    theme,
    themeMode,
    sidebarOpen: window.innerWidth > 900,
    settingsOpen: false,
    settingsTab: 'account',
    setThemeMode(mode) {
      if (mode === 'system') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, mode);
      const next = resolveTheme(mode);
      applyTheme(next);
      set({ themeMode: mode, theme: next });
    },
    setSidebarOpen(v) { set({ sidebarOpen: v }); },
    openSettings(tab) { set({ settingsOpen: true, ...(tab ? { settingsTab: tab } : {}) }); },
    closeSettings() { set({ settingsOpen: false }); },
    setSettingsTab(tab) { set({ settingsTab: tab }); },
  };
});

// ---- html preview panel ----
// A code block's "弹出预览" pops its HTML into a side panel (Shell renders it
// next to <main>). Content is a snapshot taken at click time, not live state.
interface HtmlPreviewState {
  src: string | null;
  open(src: string): void;
  close(): void;
}

export const useHtmlPreview = create<HtmlPreviewState>((set) => ({
  src: null,
  open(src) { set({ src }); },
  close() { set({ src: null }); },
}));

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

// ---- composer insert bus ----
// Anything on a page that wants to drop text into the composer (划词引用,
// etc.) publishes here; the mounted Composer consumes it, appends, focuses.
// A nonce makes two identical inserts in a row distinguishable.
interface ComposerInsertState {
  pending: { text: string; nonce: number } | null;
  insert(text: string): void;
  consume(): void;
}

export const useComposerInsert = create<ComposerInsertState>((set) => ({
  pending: null,
  insert(text) { set({ pending: { text, nonce: Date.now() + Math.random() } }); },
  consume() { set({ pending: null }); },
}));

// ---- outgoing message queue (per chat) ----
// While a reply streams, further sends queue instead of being blocked; the chat
// page auto-dispatches the next item whenever the chat is open and idle. Held
// in memory (module state) so switching conversations keeps every queue.
export interface QueuedMessage {
  id: string;
  text: string;
  attachments: PendingAttachment[];
}

interface QueueState {
  queues: Record<string, QueuedMessage[]>;
  enqueue(chatId: string, text: string, attachments: PendingAttachment[]): void;
  update(chatId: string, id: string, text: string): void;
  remove(chatId: string, id: string): void;
  /** Move one item to the front (used by 立即发送). */
  promote(chatId: string, id: string): void;
  shift(chatId: string): QueuedMessage | null;
}

export const useQueue = create<QueueState>((set, get) => {
  const patch = (chatId: string, fn: (q: QueuedMessage[]) => QueuedMessage[]) => {
    const queues = { ...get().queues };
    const next = fn(queues[chatId] ?? []);
    if (next.length) queues[chatId] = next; else delete queues[chatId];
    set({ queues });
  };
  return {
    queues: {},
    enqueue(chatId, text, attachments) {
      patch(chatId, (q) => [...q, { id: crypto.randomUUID(), text, attachments }]);
    },
    update(chatId, id, text) {
      patch(chatId, (q) => q.map((x) => (x.id === id ? { ...x, text } : x)));
    },
    remove(chatId, id) {
      patch(chatId, (q) => q.filter((x) => x.id !== id));
    },
    promote(chatId, id) {
      patch(chatId, (q) => {
        const item = q.find((x) => x.id === id);
        return item ? [item, ...q.filter((x) => x.id !== id)] : q;
      });
    },
    shift(chatId) {
      const q = get().queues[chatId] ?? [];
      if (!q.length) return null;
      patch(chatId, (list) => list.slice(1));
      return q[0];
    },
  };
});

// The composer remembers the last explicitly chosen model across pages.
export const LAST_MODEL_KEY = 'cat-last-model';

// One-shot handoff: the project page's composer stashes its full payload here,
// then navigates to `/?project=<id>`; the chat page consumes it and auto-sends.
// Module-level (not router state) so back-navigation can never replay the send.
export interface ChatHandoffPayload {
  text: string;
  attachments: PendingAttachment[];
  modelId: string | null;
  settings: ComposerSettings;
  webSearch: boolean;
  mcpSelected: string[];
}
export const chatHandoff: { payload: ChatHandoffPayload | null } = { payload: null };

// ---- announcement banner ----
// Server-set notice shown to every signed-in user. Dismissal is per content
// version: localStorage remembers the updatedAt that was dismissed, so an
// edited announcement re-surfaces for everyone.
const ANNOUNCEMENT_DISMISS_KEY = 'cat-announcement-dismissed';

interface AnnouncementState {
  text: string;
  updatedAt: number;
  loaded: boolean;
  load(force?: boolean): Promise<void>;
  dismiss(): void;
  /** Visible = non-empty and this version not yet dismissed. */
  dismissedAt: number;
}

export const useAnnouncement = create<AnnouncementState>((set, get) => ({
  text: '',
  updatedAt: 0,
  loaded: false,
  dismissedAt: Number(localStorage.getItem(ANNOUNCEMENT_DISMISS_KEY) ?? 0),
  async load(force) {
    if (get().loaded && !force) return;
    const r = await api.get<{ text: string; updatedAt: number }>('/api/announcement');
    set({ text: r.text, updatedAt: r.updatedAt, loaded: true });
  },
  dismiss() {
    const at = get().updatedAt;
    localStorage.setItem(ANNOUNCEMENT_DISMISS_KEY, String(at));
    set({ dismissedAt: at });
  },
}));

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

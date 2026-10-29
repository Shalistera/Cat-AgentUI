import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, BrushCleaning, PanelLeft, Image as ImageIcon, ListChecks, Sparkles, Trash2,
} from 'lucide-react';
import { useUi, useAuth } from '../store';
import { api } from '../api';
import {
  Button, EmptyState, PageHeader, Pager, SegmentedControl, Spinner, btnClass, confirmDialog, toast,
} from '../components/ui';
import { ImageLightbox, ImageTile } from '../components/ImageGallery';
import { ImageCleanupDialog, ImageStorageMeter } from '../components/ImageStorage';
import { NoWorkshopAccess } from '../components/NoWorkshopAccess';
import { t, locale } from '../i18n';
import type { ImageRecord, ImageStorageInfo } from '../types';

const PAGE_SIZE = 24;

type Sort = 'newest' | 'oldest';

// The full archive of generated images — the workshop page only previews the
// most recent handful and links here. Paged, so a huge archive never puts
// thousands of <img> in the DOM at once.
export default function Gallery() {
  const user = useAuth((s) => s.user);
  if (user && !user.allowImages) return <NoWorkshopAccess />;
  return <GalleryInner />;
}

function GalleryInner() {
  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const setSidebarOpen = useUi((s) => s.setSidebarOpen);

  // Page and order live in the URL, so a reload or the back button keeps your
  // place. ?cleanup=1 (from a "storage full" prompt elsewhere) opens 清理空间.
  const [search, setSearch] = useSearchParams();
  const sort: Sort = search.get('sort') === 'oldest' ? 'oldest' : 'newest';
  const page = Math.max(0, Math.floor(Number(search.get('page')) || 1) - 1);

  const [list, setList] = useState<ImageRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [storage, setStorage] = useState<ImageStorageInfo | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [lightbox, setLightbox] = useState<ImageRecord | null>(null);
  const [cleanupOpen, setCleanupOpen] = useState(() => search.get('cleanup') === '1');
  const scrollRef = useRef<HTMLDivElement>(null);
  const shownRef = useRef<string | null>(null);

  // ---- manage (batch select) mode ----
  // Selection is keyed by id and survives page flips, so you can pick across
  // pages before deleting.
  const [manage, setManage] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function goTo(next: { page?: number; sort?: Sort }) {
    const params = new URLSearchParams();
    const s = next.sort ?? sort;
    const p = next.page ?? page;
    if (s === 'oldest') params.set('sort', 'oldest');
    if (p > 0) params.set('page', String(p + 1));
    setSearch(params, { replace: true });
  }

  // The dialog is already open; drop ?cleanup=1 so a reload doesn't reopen it.
  useEffect(() => {
    if (search.get('cleanup') === '1') goTo({});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let current = true;
    let redirected = false;
    setLoading(true);
    api.get<{ images: ImageRecord[]; total: number; storage?: ImageStorageInfo }>(
      `/api/images?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}&sort=${sort}`,
    )
      .then((r) => {
        if (!current) return;
        const images = r.images ?? [];
        // Past the end (after deletions, or a stale link): land on the last
        // page, still "loading" so no empty state flashes in between.
        if (!images.length && r.total > 0 && page > 0) {
          redirected = true;
          goTo({ page: Math.ceil(r.total / PAGE_SIZE) - 1 });
          return;
        }
        setList(images);
        setTotal(r.total ?? 0);
        setStorage(r.storage ?? null);
        // Only a real page/order change scrolls back up — not a refresh after a delete.
        const key = `${sort}:${page}`;
        if (shownRef.current !== null && shownRef.current !== key) scrollRef.current?.scrollTo({ top: 0 });
        shownRef.current = key;
      })
      .catch((err) => { if (current) toast(err instanceof Error ? err.message : t('加载图片失败'), 'err'); })
      .finally(() => {
        if (!current || redirected) return;
        setLoaded(true);
        setLoading(false);
      });
    return () => { current = false; };
  }, [page, sort, reloadTick]); // eslint-disable-line react-hooks/exhaustive-deps

  const reload = () => setReloadTick((n) => n + 1);

  function toggleSel(id: string) {
    setSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function deleteSelected() {
    if (!sel.size || deleting) return;
    if (!(await confirmDialog(t('批量删除'), t('确定删除选中的 {n} 张图片?此操作不可恢复。', { n: sel.size })))) return;
    setDeleting(true);
    try {
      const r = await api.post<{ deleted: number }>('/api/images/batch-delete', { ids: [...sel] });
      setSel(new Set());
      toast(t('已删除 {n} 张图片', { n: r.deleted }), 'ok');
      reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : t('删除失败'), 'err');
    } finally {
      setDeleting(false);
    }
  }

  const pageAllSelected = list.length > 0 && list.every((x) => sel.has(x.id));

  return (
    <div className="contents">
      <PageHeader
        title={t('作品集')}
        subtitle={total > 0 ? t('共 {total} 张图片', { total: total.toLocaleString(locale) }) : t('所有生成过的图片')}
        left={!sidebarOpen && (
          <Button variant="ghost" size="icon" title={t('展开侧栏')} onClick={() => setSidebarOpen(true)}>
            <PanelLeft size={16} />
          </Button>
        )}
      >
        <Link
          to="/images"
          className={btnClass('ghost', 'sm')}
        >
          <ArrowLeft size={14} />{t('返回工坊')}
        </Link>
      </PageHeader>

      <div ref={scrollRef} className="flex-1 overflow-y-auto bg-bg0">
        <div className="mx-auto max-w-5xl p-6">
          {!loaded ? (
            <div className="flex justify-center py-16 text-tx3"><Spinner className="h-5 w-5" /></div>
          ) : list.length === 0 ? (
            <div className="rounded-xl border border-line bg-bg1">
              <EmptyState
                icon={<ImageIcon size={22} />}
                title={t('还没有生成过图片')}
                hint={t('回到绘图工坊,开始你的第一次创作。')}
                action={(
                  <Link to="/images" className={btnClass('outline', 'sm')}>
                    <Sparkles size={14} />{t('去绘图工坊')}
                  </Link>
                )}
              />
            </div>
          ) : (
            <>
              {storage && (
                <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2.5 rounded-lg border border-line bg-bg1 px-3.5 py-2.5 shadow-xs">
                  <div className="min-w-[14rem] flex-1"><ImageStorageMeter info={storage} /></div>
                  <Button variant="outline" size="sm" onClick={() => setCleanupOpen(true)}>
                    <BrushCleaning size={14} />{t('清理空间')}
                  </Button>
                </div>
              )}
              <div className="mb-3 flex min-h-8 flex-wrap items-center justify-between gap-2">
                <SegmentedControl<Sort>
                  value={sort}
                  onChange={(s) => goTo({ sort: s, page: 0 })}
                  options={[{ value: 'newest', label: t('最新在前') }, { value: 'oldest', label: t('最早在前') }]}
                />
                {manage ? (
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <span className="text-[13px] tabular-nums text-tx2">{t('已选 {n} 张', { n: sel.size })}</span>
                    <Button
                      variant="outline" size="sm"
                      onClick={() => setSel((prev) => {
                        const next = new Set(prev);
                        if (pageAllSelected) list.forEach((x) => next.delete(x.id));
                        else list.forEach((x) => next.add(x.id));
                        return next;
                      })}
                    >
                      {pageAllSelected ? t('取消本页全选') : t('全选本页')}
                    </Button>
                    <Button variant="dangerSolid" size="sm" disabled={!sel.size || deleting} onClick={deleteSelected}>
                      {deleting ? <Spinner className="h-3.5 w-3.5" /> : <Trash2 size={14} />}
                      {t('删除所选')}{sel.size > 0 && ` (${sel.size})`}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => { setManage(false); setSel(new Set()); }}>
                      {t('完成')}
                    </Button>
                  </div>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => setManage(true)}>
                    <ListChecks size={14} />{t('批量管理')}
                  </Button>
                )}
              </div>
              <div className={`grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 ${loading ? 'pointer-events-none opacity-60' : ''}`}>
                {list.map((img) => (
                  <ImageTile
                    key={img.id}
                    img={img}
                    selectMode={manage}
                    selected={sel.has(img.id)}
                    onClick={() => (manage ? toggleSel(img.id) : setLightbox(img))}
                  />
                ))}
              </div>
              <div className="mt-5">
                <Pager page={page} pages={pages} disabled={loading} onChange={(p) => goTo({ page: p })} />
              </div>
            </>
          )}
        </div>
      </div>

      <ImageLightbox
        image={lightbox}
        onClose={() => setLightbox(null)}
        onDeleted={(img) => {
          setSel((prev) => {
            if (!prev.has(img.id)) return prev;
            const next = new Set(prev);
            next.delete(img.id);
            return next;
          });
          setLightbox(null);
          reload();
        }}
      />

      <ImageCleanupDialog
        open={cleanupOpen}
        onClose={() => setCleanupOpen(false)}
        onChanged={() => { setSel(new Set()); reload(); }}
      />
    </div>
  );
}

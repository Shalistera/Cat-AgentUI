import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft, ChevronLeft, ChevronRight, PanelLeft, Image as ImageIcon, ListChecks, Sparkles, Trash2,
} from 'lucide-react';
import { useUi, useAuth } from '../store';
import { api } from '../api';
import { Button, EmptyState, PageHeader, Spinner, btnClass, confirmDialog, toast } from '../components/ui';
import { ImageLightbox, ImageTile } from '../components/ImageGallery';
import { NoWorkshopAccess } from '../components/NoWorkshopAccess';
import { t, locale } from '../i18n';
import type { ImageRecord } from '../types';

const PAGE_SIZE = 24;

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

  const [list, setList] = useState<ImageRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [lightbox, setLightbox] = useState<ImageRecord | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // ---- manage (batch select) mode ----
  // Selection is keyed by id and survives page flips, so you can pick across
  // pages before deleting.
  const [manage, setManage] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  async function fetchPage(p: number) {
    setLoading(true);
    try {
      const r = await api.get<{ images: ImageRecord[]; total: number }>(
        `/api/images?limit=${PAGE_SIZE}&offset=${p * PAGE_SIZE}`,
      );
      setList(r.images ?? []);
      setTotal(r.total ?? 0);
      setPage(p);
      scrollRef.current?.scrollTo({ top: 0 });
    } catch (err) {
      toast(err instanceof Error ? err.message : t('加载图片失败'), 'err');
    } finally {
      setLoaded(true);
      setLoading(false);
    }
  }

  useEffect(() => { void fetchPage(0); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // After deletions the tail of the archive shifts — re-pull the current page
  // (clamped, in case the last page just vanished).
  function refreshAfterDelete(removed: number) {
    const lastPage = Math.max(0, Math.ceil(Math.max(0, total - removed) / PAGE_SIZE) - 1);
    void fetchPage(Math.min(page, lastPage));
  }

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
      refreshAfterDelete(r.deleted);
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
              <div className="mb-3 flex min-h-8 flex-wrap items-center justify-between gap-2">
                {manage ? (
                  <>
                    <span className="text-[13px] tabular-nums text-tx2">{t('已选 {n} 张', { n: sel.size })}</span>
                    <div className="flex flex-wrap items-center gap-2">
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
                  </>
                ) : (
                  <Button variant="outline" size="sm" className="ml-auto" onClick={() => setManage(true)}>
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
              {pages > 1 && (
                <div className="mt-5 flex items-center justify-center gap-3">
                  <Button
                    variant="outline" size="sm"
                    disabled={page === 0 || loading}
                    onClick={() => fetchPage(page - 1)}
                  >
                    <ChevronLeft size={14} />{t('上一页')}
                  </Button>
                  <span className="text-[13px] tabular-nums text-tx2">
                    {t('第 {page} / {pages} 页', { page: page + 1, pages })}
                  </span>
                  <Button
                    variant="outline" size="sm"
                    disabled={page >= pages - 1 || loading}
                    onClick={() => fetchPage(page + 1)}
                  >
                    {t('下一页')}<ChevronRight size={14} />
                  </Button>
                </div>
              )}
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
          refreshAfterDelete(1);
        }}
      />
    </div>
  );
}

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, ExternalLink, Maximize2, Minimize2, X } from 'lucide-react';
import { create } from 'zustand';

/**
 * Image lightbox for pictures inside a conversation — model output, uploaded
 * attachments, images the Markdown links to. One global instance (mounted in
 * Shell) so every ChatMessage can open it without owning modal state.
 * 绘图工坊 keeps its own richer ImageLightbox (metadata, delete).
 */
interface LightboxState {
  src: string | null;
  alt: string;
  open(src: string, alt?: string): void;
  close(): void;
}

export const useLightbox = create<LightboxState>((set) => ({
  src: null,
  alt: '',
  open(src, alt = '') { set({ src, alt }); },
  close() { set({ src: null }); },
}));

const btn = 'flex h-9 w-9 cursor-pointer items-center justify-center rounded-md text-white/85 transition-colors hover:bg-white/15 hover:text-white';

export function LightboxHost() {
  const src = useLightbox((s) => s.src);
  const alt = useLightbox((s) => s.alt);
  const close = useLightbox((s) => s.close);
  // fit = contained in the viewport; full = natural size, scrollable.
  const [full, setFull] = useState(false);

  useEffect(() => { if (src) setFull(false); }, [src]);
  useEffect(() => {
    if (!src) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [src, close]);

  if (!src) return null;
  const isBlob = src.startsWith('blob:') || src.startsWith('data:');
  return createPortal(
    <div className="fixed inset-0 z-[70] flex flex-col bg-black/90" role="dialog" aria-modal="true" aria-label="查看图片">
      <div className="flex shrink-0 items-center justify-end gap-1 px-3 py-2">
        <button className={btn} title={full ? '适应窗口' : '原始大小'} onClick={() => setFull((v) => !v)}>
          {full ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
        </button>
        {!isBlob && (
          <a className={btn} title="在新标签页打开" href={src} target="_blank" rel="noreferrer">
            <ExternalLink size={17} />
          </a>
        )}
        <a className={btn} title="下载" href={src} download>
          <Download size={17} />
        </a>
        <button className={btn} title="关闭 (Esc)" onClick={close}><X size={19} /></button>
      </div>
      {/* Clicking the backdrop (not the picture) closes; the picture itself
          toggles fit/full like every desktop image viewer. */}
      <div
        className={`min-h-0 flex-1 ${full ? 'overflow-auto' : 'flex items-center justify-center overflow-hidden'} px-3 pb-3`}
        onClick={(e) => { if (e.target === e.currentTarget) close(); }}
      >
        <img
          src={src}
          alt={alt}
          onClick={() => setFull((v) => !v)}
          className={full
            ? 'mx-auto block max-w-none cursor-zoom-out'
            : 'max-h-full max-w-full cursor-zoom-in select-none rounded-md object-contain shadow-2xl'}
          draggable={false}
        />
      </div>
    </div>,
    document.body,
  );
}

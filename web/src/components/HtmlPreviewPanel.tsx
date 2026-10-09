import { useState } from 'react';
import { withCanvasCsp } from '../sandboxedHtml';
import { RotateCw, X } from 'lucide-react';
import { useHtmlPreview } from '../store';
import { t } from '../i18n';

const headBtn = 'flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-tx2 transition-colors hover:bg-bg3 hover:text-tx';

// Side panel for popped-out HTML previews (claude.ai artifact style). Rendered
// in Shell as a flex sibling of <main> so the conversation column squeezes on
// desktop; on phones it takes over the whole viewport instead.
export function HtmlPreviewPanel() {
  const src = useHtmlPreview((s) => s.src);
  const close = useHtmlPreview((s) => s.close);
  // Remounting the iframe is the only way to re-run scripts in the snapshot.
  const [reloadKey, setReloadKey] = useState(0);

  if (src === null) return null;

  return (
    <aside className="fixed inset-0 z-40 flex flex-col bg-bg1 md:static md:z-auto md:w-[clamp(22rem,42vw,45rem)] md:shrink-0 md:border-l md:border-line">
      <div className="flex items-center justify-between border-b border-line bg-bg2 py-1.5 pl-4 pr-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-tx3">{t('HTML 预览')}</span>
        <div className="flex items-center gap-1">
          <button className={headBtn} title={t('重新加载')} onClick={() => setReloadKey((k) => k + 1)}>
            <RotateCw size={14} />
          </button>
          <button className={headBtn} title={t('关闭预览')} onClick={close}>
            <X size={15} />
          </button>
        </div>
      </div>
      {/* No allow-same-origin: previewed HTML must not reach our cookies/localStorage. */}
      <iframe
        key={reloadKey}
        sandbox="allow-scripts allow-modals"
        srcDoc={withCanvasCsp(src)}
        title={t('HTML 预览')}
        className="block w-full flex-1 border-0 bg-white"
      />
    </aside>
  );
}

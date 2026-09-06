import { Check, Download, Trash2 } from 'lucide-react';
import { api, fmtDuration, fmtModelName, fmtTime, fmtTokens } from '../api';
import { Badge, Button, Modal, ModalActions, btnClass, confirmDialog, toast } from './ui';
import type { ImageRecord } from '../types';

// Hover gradient with the prompt and model chip — shared by ImageTile and the
// featured card on the workshop page. Expects a `group` ancestor; also shows
// on keyboard focus within the tile.
export function TileOverlay({ prompt, model, featured = false }: {
  prompt?: string; model?: string | null; featured?: boolean;
}) {
  return (
    <div className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 ${
      featured ? 'p-3 pt-12' : 'p-2.5 pt-10'
    }`}>
      <p className={`line-clamp-2 leading-snug text-white ${featured ? 'text-xs' : 'text-[11px]'}`}>{prompt}</p>
      {model && (
        <span className="mt-1.5 inline-block max-w-full truncate rounded-sm bg-white/20 px-1.5 py-0.5 font-mono text-[10px] text-white">
          {fmtModelName(model)}
        </span>
      )}
    </div>
  );
}

// Square thumbnail with hover prompt/model overlay — shared between the
// workshop page and the full gallery. In selectMode the whole tile becomes a
// checkbox: onClick then toggles instead of opening the lightbox.
export function ImageTile({ img, onClick, selectMode = false, selected = false }: {
  img: ImageRecord; onClick: () => void; selectMode?: boolean; selected?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group relative aspect-square cursor-pointer overflow-hidden rounded-lg border bg-bg1 text-left shadow-xs transition-shadow hover:shadow-md ${
        selected ? 'border-acc ring-2 ring-acc' : 'border-line'
      }`}
    >
      <img
        loading="lazy"
        src={`/api/images/${img.id}/file`}
        alt={img.prompt}
        className={`h-full w-full object-cover ${selected ? 'opacity-75' : ''}`}
      />
      {selectMode && (
        <span
          className={`absolute left-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-full transition-colors ${
            selected ? 'bg-accs text-accfg' : 'bg-black/40 text-transparent ring-1 ring-white/70'
          }`}
        >
          <Check size={14} />
        </span>
      )}
      <TileOverlay prompt={img.prompt} model={img.model} />
    </button>
  );
}

// Detail modal with download + delete. Deletion is confirmed here; the parent
// only hears about it after the server accepted it.
export function ImageLightbox({ image, onClose, onDeleted }: {
  image: ImageRecord | null;
  onClose: () => void;
  onDeleted: (img: ImageRecord) => void;
}) {
  async function del() {
    if (!image) return;
    if (!(await confirmDialog('删除图片', '确定删除这张图片?此操作不可恢复。'))) return;
    try {
      await api.del(`/api/images/${image.id}`);
      toast('已删除', 'ok');
      onDeleted(image);
    } catch (err) {
      toast(err instanceof Error ? err.message : '删除失败', 'err');
    }
  }

  return (
    <Modal open={!!image} onClose={onClose} title="图片详情" wide>
      {image && (
        <div className="space-y-4">
          <img
            src={`/api/images/${image.id}/file`}
            alt={image.prompt}
            className="mx-auto max-h-[58vh] rounded-lg border border-line bg-bg0 object-contain"
          />
          <p className="select-text whitespace-pre-wrap text-[13px] leading-relaxed text-tx2">{image.prompt}</p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs tabular-nums text-tx3">
            {image.model && <Badge mono>{fmtModelName(image.model)}</Badge>}
            {image.size && <span>尺寸 {image.size}</span>}
            <span>耗时 {fmtDuration(image.durationMs)}</span>
            <span>{fmtTime(image.createdAt)}</span>
            {image.tokens != null && image.tokens > 0 && <span>Tokens {fmtTokens(image.tokens)}</span>}
          </div>
          <ModalActions>
            <a
              href={`/api/images/${image.id}/file`}
              download
              className={btnClass('outline', 'md')}
            >
              <Download size={14} />下载
            </a>
            <Button variant="danger" onClick={del}>
              <Trash2 size={14} />删除
            </Button>
          </ModalActions>
        </div>
      )}
    </Modal>
  );
}

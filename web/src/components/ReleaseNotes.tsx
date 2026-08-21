import { useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { Modal } from './ui';
import {
  appVersion,
  appVersionLabel,
  appVersionTitle,
  recentChanges,
} from '../version';

export function ReleaseNotesButton({ className = '' }: { className?: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className={`cursor-pointer rounded-sm font-mono transition-colors ${className}`}
        title="查看更新日志"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        {appVersionLabel}
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="更新日志"
        desc={`v${appVersion} · 根据近期 GitHub 提交整理`}
        wide
      >
        <div className="space-y-6">
          {recentChanges.map((group, index) => (
            <section key={group.date} className="relative pl-6">
              <span
                aria-hidden
                className={`absolute left-[5px] top-2 h-full w-px bg-line ${index === recentChanges.length - 1 ? 'hidden' : ''}`}
              />
              <span className="absolute left-0 top-1.5 h-[11px] w-[11px] rounded-full border-2 border-bg1 bg-acc ring-1 ring-line" />
              <div className="flex items-center gap-1.5 text-xs font-medium text-tx2">
                <CalendarDays size={13} className="text-tx3" />
                <time>{group.date}</time>
              </div>
              <ul className="mt-2 space-y-1.5 text-[13px] leading-relaxed text-tx2">
                {group.items.map((item) => (
                  <li key={item} className="flex gap-2">
                    <span aria-hidden className="mt-[0.65em] h-1 w-1 shrink-0 rounded-full bg-tx3" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <p className="border-t border-line pt-3 font-mono text-[10px] leading-relaxed text-tx3" title={appVersionTitle}>
            {appVersionTitle.replaceAll('\n', ' · ')}
          </p>
        </div>
      </Modal>
    </>
  );
}

import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useWorkspacePanel } from '../store';
import { workspaceFileHref } from '../workspaceLinks';

export function WorkspaceFileLink({ chatId, path, children, className }: {
  chatId: string; path: string; children: ReactNode; className?: string;
}) {
  const location = useLocation();
  return (
    <Link to={workspaceFileHref(chatId, path)} className={className}
      title={`在工作区打开「${path}」`}
      onClick={(e) => {
        e.stopPropagation();
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        // Opening a file in the current chat must not reload/interrupt its stream.
        if (location.pathname === `/chat/${chatId}`) {
          e.preventDefault();
          useWorkspacePanel.getState().openFile(chatId, path);
        }
      }}>
      {children}
    </Link>
  );
}

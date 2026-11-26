'use client';

import { ShieldCheck } from 'lucide-react';
import { useOperationApprovals } from '@/components/chat/operation-approvals';
import { useT } from '@/lib/i18n';
import { useWorkspace } from '@/lib/workspace-context';
import { useLayout } from './layout-context';

export function OperationApprovalNotifications({ onOpen }: { onOpen: (sessionId: string) => void }) {
  const t = useT();
  const { requests, error } = useOperationApprovals();
  const pending = requests.filter(request => request.status === 'pending' && request.can_decide);
  if (!pending.length && !error) return null;
  return <details className="relative shrink-0">
    <summary className="flex cursor-pointer list-none items-center gap-1 rounded-md px-2 py-1 text-xs" title={t('operationApproval.pendingCount', { count: pending.length })}>
      <ShieldCheck className="size-4" aria-hidden="true" />
      <span className="sr-only">{t('operationApproval.pendingCount', { count: pending.length })}</span>
      <span aria-hidden="true">{pending.length}{error ? ' !' : ''}</span>
    </summary>
    <div className="absolute right-0 z-50 mt-2 max-h-72 w-72 overflow-auto rounded-md border border-border bg-popover p-2 text-xs shadow-md">
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {pending.map(request => <button key={request.id} type="button" className="block w-full break-all rounded px-2 py-2 text-left hover:bg-accent" onClick={event => {
        event.currentTarget.closest('details')?.removeAttribute('open');
        onOpen(request.session_id);
      }}>{request.agent_name} · {request.visitor_email}</button>)}
    </div>
  </details>;
}

export function WorkspaceOperationApprovals() {
  const { workspace, currentUser, setCurrentSessionId } = useWorkspace();
  const { openView, isMobile, openMobileDetail } = useLayout();
  if (!workspace?.workspaceId || !currentUser?.isAuthenticated) return null;
  return <OperationApprovalNotifications key={`${workspace.workspaceId}:${currentUser.id}`} onOpen={sessionId => {
    openView('threads');
    setCurrentSessionId(sessionId);
    if (isMobile) openMobileDetail();
  }} />;
}

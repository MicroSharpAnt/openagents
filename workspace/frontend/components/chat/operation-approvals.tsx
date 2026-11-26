'use client';

import { useEffect, useRef, useState } from 'react';
import { workspaceApi } from '@/lib/api';
import { useT } from '@/lib/i18n';
import type { OperationApproval, OperationDecision } from '@/lib/operation-approvals';
import { Button } from '@/components/ui/button';

export function useOperationApprovals(sessionId?: string) {
  const [requests, setRequests] = useState<OperationApproval[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const deciding = useRef(false);
  const revision = useRef(0);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      if (deciding.current) return;
      const version = ++revision.current;
      try {
        const next = await workspaceApi.listOperationApprovals(sessionId);
        if (alive && version === revision.current && !deciding.current) {
          setRequests(next); setError('');
        }
      } catch (err) {
        if (alive && version === revision.current) setError(err instanceof Error ? err.message : String(err));
      }
    };
    refreshRef.current = refresh;
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
    const onVisible = () => { if (!document.hidden) void refresh(); };
    window.addEventListener('online', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => { alive = false; revision.current++; clearInterval(timer); window.removeEventListener('online', onVisible); document.removeEventListener('visibilitychange', onVisible); };
  }, [sessionId]);
  const decide = async (id: string, decision: OperationDecision) => {
    if (deciding.current) return;
    deciding.current = true; const version = ++revision.current;
    setBusy(id); setError('');
    try {
      const next = await workspaceApi.decideOperationApproval(id, decision);
      if (version === revision.current) setRequests(previous => previous.map(item => item.id === id ? next : item));
    } catch (err) {
      if (version === revision.current) {
        // Refresh expired/changed authority, while preserving the rejected decision's error.
        deciding.current = false;
        await refreshRef.current();
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally { deciding.current = false; setBusy(null); }
  };
  return { requests, error, busy, decide };
}

export function OperationApprovals({ sessionId }: { sessionId: string }) {
  const t = useT();
  const { requests, error, busy, decide } = useOperationApprovals(sessionId);
  if (!requests.length && !error) return null;
  return <section aria-label={t('operationApproval.title')} className="max-h-72 shrink-0 overflow-y-auto border-b border-border px-4 py-2 text-xs">
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {requests.map(request => <article key={request.id} className="my-2 rounded-lg border border-border p-3">
      <h3 className="font-medium">{t('operationApproval.title')} · {request.agent_name}</h3>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 break-all">
        <dt>{t('operationApproval.owner')}</dt><dd>{request.owner_email}</dd>
        <dt>{t('operationApproval.requester')}</dt><dd>{request.visitor_email}</dd>
        <dt>{t('operationApproval.root')}</dt><dd className="font-mono whitespace-pre-wrap">{request.operation.root}</dd>
        <dt>{t('operationApproval.source')}</dt><dd className="font-mono whitespace-pre-wrap">{request.operation.source}</dd>
        <dt>{t('operationApproval.destination')}</dt><dd className="font-mono whitespace-pre-wrap">{request.operation.destination}</dd>
        <dt>{t('operationApproval.expires')}</dt><dd><time dateTime={request.expires_at}>{new Date(request.expires_at).toLocaleString()}</time></dd>
      </dl>
      <p role="status" className="mt-2">{t(request.status === 'approved' && request.paused ? 'operationApproval.waitingForResume' : `operationApproval.${request.status}`)}</p>
      <div className="mt-2 flex gap-2">
        {request.can_decide && <>
          <Button size="sm" disabled={busy !== null} onClick={() => void decide(request.id, 'approve')}>{t('operationApproval.approve')}</Button>
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void decide(request.id, 'reject')}>{t('operationApproval.reject')}</Button>
        </>}
        {request.can_withdraw && <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void decide(request.id, 'withdraw')}>{t('operationApproval.withdraw')}</Button>}
      </div>
    </article>)}
  </section>;
}

'use client';

import { useEffect, useRef, useState } from 'react';
import { workspaceApi } from '@/lib/api';
import { dmPair } from '@/lib/dm';
import { useLiveStream } from '@/lib/live-stream-context';
import { useT } from '@/lib/i18n';
import type { DirectConversationState } from '@/lib/types';
import { Button } from '@/components/ui/button';

export function useDirectConversation(sessionId: string | null) {
  const [state, setState] = useState<DirectConversationState | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(sessionId);
  active.current = sessionId;
  const revision = useRef(0);
  const { stream } = useLiveStream();
  useEffect(() => {
    setState(null); setError(''); setPending(false);
    const pair = dmPair(sessionId);
    if (!sessionId || pair.length !== 2 || !pair.some(p => p.startsWith('human:') && p.includes('@'))
        || !pair.some(p => p.startsWith('openagents:'))) return;
    let alive = true;
    const refresh = async () => {
      const version = revision.current;
      try {
        const next = await workspaceApi.directConversationState(sessionId);
        if (alive && version === revision.current) setState(next);
      } catch { if (alive && version === revision.current) setState(null); }
    };
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
    const unsubscribe = stream?.onEvent(event => {
      if (event.type === 'workspace.direct_conversation.updated' && (event.payload as { session_id?: string } | undefined)?.session_id === sessionId) void refresh();
    });
    return () => { alive = false; clearInterval(timer); unsubscribe?.(); };
  }, [sessionId, stream]);
  const current = state?.session_id === sessionId ? state : null;
  const toggle = async () => {
    if (!current?.can_manage || pending || !sessionId) return;
    revision.current += 1;
    setPending(true); setError('');
    try {
      const next = await workspaceApi.setConversationTakeover(sessionId, !current.paused);
      if (active.current === sessionId) setState(next);
    } catch (err) {
      if (active.current === sessionId) setError(err instanceof Error ? err.message : String(err));
    } finally {
      revision.current += 1;
      if (active.current === sessionId) setPending(false);
    }
  };
  return { state: current, pending, error, toggle };
}

export function DirectConversationControls({ conversation }: { conversation: ReturnType<typeof useDirectConversation> }) {
  const t = useT();
  const { state, pending, error, toggle } = conversation;
  if (!state?.owner_email) return null;
  return <div className="border-b border-border px-4 py-2 text-xs text-muted-foreground" data-agent-conversation>
    <div className="flex items-center justify-between gap-3">
      <div><p>{t('agentConversation.notice')}</p>
        <p className="mt-1">{t(state.paused ? 'agentConversation.paused' : 'agentConversation.automatic')}</p></div>
      {state.can_manage && <Button size="sm" variant="outline" disabled={pending} onClick={() => void toggle()}>
        {t(state.paused ? 'agentConversation.resume' : 'agentConversation.takeOver')}
      </Button>}
    </div>
    {error && <p role="alert" className="mt-1 text-destructive">{error}</p>}
  </div>;
}

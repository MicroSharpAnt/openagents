import { describe, expect, it } from 'vitest';
import { eventToMessage, type ONMEvent } from '@/lib/types';
import { messagesForSession } from './chat-message-cache';
const session = 'dm:human:visitor@test.dev,openagents:bot';
const event = (source: string, target: string, metadata = {}): ONMEvent => ({
  id: source, type: 'workspace.message.posted', source, target, metadata,
  visibility: 'direct', timestamp: 1, payload: { content: 'hello' },
});
describe('visitor conversation isolation', () => {
  it('does not show another visitor’s live message to the same agent', () => {
    const messages = [event('human:visitor@test.dev', 'openagents:bot'), event('human:other@test.dev', 'openagents:bot')].map(eventToMessage);
    expect(messagesForSession(session, messages).map(m => m.senderAddress)).toEqual(['human:visitor@test.dev']);
  });
  it('keeps the owner’s identity and the original conversation', () => {
    const message = eventToMessage(event('human:owner@test.dev', 'human:visitor@test.dev', { dm_agent: 'openagents:bot', dm_owner: 'owner@test.dev', dm_conversation: session }));
    expect(message.senderType).toBe('human');
    expect(message.sessionId).toBe(session);
    expect(messagesForSession(session, [message])).toHaveLength(1);
    expect(messagesForSession('dm:human:owner@test.dev,human:visitor@test.dev', [message])).toHaveLength(0);
  });
});

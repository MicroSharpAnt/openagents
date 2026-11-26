// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }));
vi.mock('@/lib/api', () => ({ workspaceApi: { directConversationState: api.get, setConversationTakeover: api.update } }));
vi.mock('@/lib/i18n', () => ({ useT: () => (key: string) => key }));
import { DirectConversationControls, useDirectConversation } from './direct-conversation-controls';
const session = 'dm:human:visitor@test.dev,openagents:bot';
const initial = { session_id: session, owner_email: 'owner@test.dev', can_manage: true, paused: false };
function Harness() {
  const conversation = useDirectConversation(session);
  return React.createElement(DirectConversationControls, { conversation });
}
let host: HTMLDivElement; let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); root = createRoot(host);
  api.get.mockResolvedValue(initial); api.update.mockReset();
});
afterEach(async () => { await act(async () => root.unmount()); vi.restoreAllMocks(); });
it('explains owner access and supports takeover then resume', async () => {
  api.update.mockImplementation(async (_session: string, paused: boolean) => ({ ...initial, paused }));
  await act(async () => root.render(React.createElement(Harness)));
  expect(host.textContent).toContain('agentConversation.notice');
  expect(host.textContent).toContain('agentConversation.takeOver');
  await act(async () => host.querySelector('button')!.click());
  expect(api.update).toHaveBeenLastCalledWith(session, true);
  expect(host.textContent).toContain('agentConversation.paused');
  expect(host.textContent).toContain('agentConversation.resume');
  await act(async () => host.querySelector('button')!.click());
  expect(api.update).toHaveBeenLastCalledWith(session, false);
});
it('shows the visitor the notice and takeover state without owner controls', async () => {
  api.get.mockResolvedValue({ ...initial, can_manage: false, paused: true });
  await act(async () => root.render(React.createElement(Harness)));
  expect(host.textContent).toContain('agentConversation.notice');
  expect(host.textContent).toContain('agentConversation.paused');
  expect(host.querySelector('button')).toBeNull();
});
it('surfaces a failed takeover and keeps the current state', async () => {
  api.update.mockRejectedValue(new Error('Access changed'));
  await act(async () => root.render(React.createElement(Harness)));
  await act(async () => host.querySelector('button')!.click());
  expect(host.querySelector('[role=alert]')?.textContent).toContain('Access changed');
  expect(host.textContent).toContain('agentConversation.takeOver');
});

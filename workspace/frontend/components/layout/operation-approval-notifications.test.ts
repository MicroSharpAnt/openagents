// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('@/lib/api', () => ({ workspaceApi: { listOperationApprovals: api.list } }));
vi.mock('@/lib/i18n', () => ({ useT: () => (key: string, params?: { count: number }) => params ? `${key} ${params.count}` : key }));
import { OperationApprovalNotifications } from './operation-approval-notifications';
let root: ReturnType<typeof createRoot>;
afterEach(async () => { if (root) await act(async () => root.unmount()); });
it('counts actionable requests across owned agents and opens the exact visitor conversation', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); root = createRoot(host);
  const onOpen = vi.fn();
  api.list.mockResolvedValue([
    { id: 'a', session_id: 'dm:human:visitor@test.dev,openagents:bot', agent_name: 'bot', visitor_email: 'visitor@test.dev', status: 'pending', can_decide: true },
    { id: 'b', session_id: 'dm:human:other@test.dev,openagents:second', agent_name: 'second', visitor_email: 'other@test.dev', status: 'pending', can_decide: true },
    { id: 'c', status: 'pending', can_decide: false },
  ]);
  await act(async () => root.render(React.createElement(OperationApprovalNotifications, { onOpen })));
  expect(host.textContent).toContain('operationApproval.pendingCount 2');
  await act(async () => host.querySelector('button')!.click());
  expect(onOpen).toHaveBeenCalledWith('dm:human:visitor@test.dev,openagents:bot');
  expect(api.list).toHaveBeenCalledWith(undefined);
});

// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ list: vi.fn(), decide: vi.fn() }));
vi.mock('@/lib/api', () => ({ workspaceApi: { listOperationApprovals: api.list, decideOperationApproval: api.decide } }));
vi.mock('@/lib/i18n', () => ({ useT: () => (key: string) => key }));
import { OperationApprovals } from './operation-approvals';
const session = 'dm:human:visitor@test.dev,openagents:bot';
const initial = { id: 'request-1', session_id: session, agent_name: 'bot', owner_email: 'owner@test.dev', visitor_email: 'visitor@test.dev', operation: { kind: 'move', root: '/work', source: 'old.txt', destination: 'new.txt', expected_state: 'hash' }, operation_digest: 'digest', status: 'pending', expires_at: '2099-01-01T00:00:00Z', created_at: '2026-11-26T00:00:00Z', result: null, paused: true, can_decide: true, can_withdraw: false };
let host: HTMLDivElement; let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); root = createRoot(host);
  api.list.mockReset().mockResolvedValue([initial]); api.decide.mockReset();
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); });
it('owner approves the exact move once and sees it waiting for resume', async () => {
  api.decide.mockResolvedValue({ ...initial, status: 'approved', can_decide: false });
  await act(async () => root.render(React.createElement(OperationApprovals, { sessionId: session })));
  for (const text of ['/work', 'old.txt', 'new.txt', 'owner@test.dev', 'visitor@test.dev', 'bot', '2099']) expect(host.textContent).toContain(text);
  const approve = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'operationApproval.approve')!;
  await act(async () => { approve.click(); approve.click(); });
  expect(api.decide).toHaveBeenCalledTimes(1);
  expect(api.decide).toHaveBeenCalledWith('request-1', 'approve');
  expect(host.textContent).toContain('operationApproval.waitingForResume');
  expect(host.textContent).not.toContain('operationApproval.succeeded');
});
it('visitor can withdraw an approved request without owner controls', async () => {
  api.list.mockResolvedValue([{ ...initial, status: 'approved', can_decide: false, can_withdraw: true }]);
  api.decide.mockResolvedValue({ ...initial, status: 'withdrawn', can_decide: false, can_withdraw: false });
  await act(async () => root.render(React.createElement(OperationApprovals, { sessionId: session })));
  expect(Array.from(host.querySelectorAll('button')).map(b => b.textContent)).toEqual(['operationApproval.withdraw']);
  await act(async () => host.querySelector('button')!.click());
  expect(api.decide).toHaveBeenCalledWith('request-1', 'withdraw');
  expect(host.textContent).toContain('operationApproval.withdrawn');
});
it('surfaces stale-decision errors and refreshes expired authority', async () => {
  api.decide.mockRejectedValue(new Error('Request expired'));
  await act(async () => root.render(React.createElement(OperationApprovals, { sessionId: session })));
  api.list.mockResolvedValue([{ ...initial, status: 'expired', can_decide: false }]);
  await act(async () => host.querySelector('button')!.click());
  expect(host.querySelector('[role=alert]')?.textContent).toBe('Request expired');
  expect(host.textContent).toContain('operationApproval.expired');
  expect(host.querySelector('button')).toBeNull();
});
it('polling during a pending decision cannot discard the result or repeat a decision', async () => {
  vi.useFakeTimers();
  let resolve!: (value: unknown) => void;
  api.decide.mockReturnValue(new Promise(r => { resolve = r; }));
  await act(async () => root.render(React.createElement(OperationApprovals, { sessionId: session })));
  await act(async () => host.querySelector('button')!.click());
  await act(async () => vi.advanceTimersByTime(5000));
  await act(async () => resolve({ ...initial, status: 'approved', can_decide: false }));
  expect(host.textContent).toContain('operationApproval.waitingForResume');
  expect(api.decide).toHaveBeenCalledTimes(1);
});
it.each(['executing','succeeded','failed','invalidated','rejected','withdrawn','expired'])('shows %s from the server without decision controls', async status => {
  api.list.mockResolvedValue([{ ...initial, status, can_decide: false }]);
  await act(async () => root.render(React.createElement(OperationApprovals, { sessionId: session })));
  expect(host.textContent).toContain(`operationApproval.${status}`);
  expect(host.querySelector('button')).toBeNull();
});

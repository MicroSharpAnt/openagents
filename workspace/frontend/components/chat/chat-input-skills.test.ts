// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatInput } from './chat-input';
import type { LocalSkill } from '@/lib/desktop-host';

const skill = { name: 'unity-mcp', path: '/local/skills/unity/SKILL.md', description: 'Unity tools', content: 'Use the Unity tools to inspect the scene.' };
vi.mock('./composer-add-menu', () => ({ ComposerAddMenu: ({ onPickSkill }: { onPickSkill: (s: LocalSkill) => void }) => React.createElement('button', { onClick: () => onPickSkill(skill) }, 'pick-skill') }));
vi.mock('./use-composer-mentions', () => ({ useComposerMentions: () => ({ mentionPeople: [], mentionItems: [], participantEmails: [], selfEmail: '', team: [] }) }));
vi.mock('@/lib/i18n', () => ({ useT: () => (key: string) => key }));
vi.stubGlobal('React', React);
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
let root: Root;
const send = vi.fn();
beforeEach(() => { send.mockReset(); const host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ''; });
async function render(conversationId = 'thread', disabled = false) { await act(async () => root.render(React.createElement(ChatInput, { conversationId, onSend: send, disabled }))); }
async function click(label: string) { await act(async () => { const button = [...document.querySelectorAll('button')].find(b => b.textContent === label || b.getAttribute('aria-label') === label)!; button.click(); }); }
it('shows a removable chip, avoids duplicates and transmits the selected instructions for an agent on another device', async () => {
  await render(); await click('pick-skill'); await click('pick-skill');
  expect(document.querySelector('[data-composer-skills]')?.textContent).toBe('unity-mcp');
  await click('chatInput.sendMessage');
  expect(send).toHaveBeenCalledOnce();
  expect(send.mock.calls[0][0]).toContain(skill.content);
  expect(send.mock.calls[0][0]).toContain('"unity-mcp": "/local/skills/unity/SKILL.md"');
  expect(document.querySelector('[data-composer-skills]')).toBeNull();
});
it('isolates skill drafts between threads and removal prevents sending the reference', async () => {
  await render('one'); await click('pick-skill'); await render('two');
  expect(document.querySelector('[data-composer-skills]')).toBeNull();
  await render('one'); expect(document.querySelector('[data-composer-skills]')).not.toBeNull();
  await click('common.remove unity-mcp'); await click('chatInput.sendMessage');
  expect(send).not.toHaveBeenCalled();
});
it('does not send or clear the skill when sending is disabled', async () => {
  await render('one', true); await click('pick-skill'); await click('chatInput.sendMessage');
  expect(send).not.toHaveBeenCalled();
  expect(document.querySelector('[data-composer-skills]')).not.toBeNull();
});

async function type(text: string) {
  await act(async () => {
    const input = document.querySelector('textarea')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function key(key: string, options = {}) {
  await act(async () => { document.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...options })); });
}
function skillHost() {
  Object.assign(window, { __oaHost__: { listLocalSkills: vi.fn().mockResolvedValue([
    { id: 'codex', label: 'Codex', directories: [], unavailable: false, skills: [skill, { ...skill, name: 'review', description: 'Code review', path: '/local/review/SKILL.md' }] },
  ]) } });
}
afterEach(() => { delete (window as unknown as { __oaHost__?: unknown }).__oaHost__; });
it('filters slash skills and Enter selects a chip instead of sending, preserving surrounding text', async () => {
  skillHost(); await render(); await type('Please use /unit');
  expect(document.querySelectorAll('[role=option]')).toHaveLength(1);
  await key('Enter');
  expect(send).not.toHaveBeenCalled();
  expect(document.querySelector('textarea')?.value).toBe('Please use ');
  expect(document.querySelector('[data-composer-skills]')?.textContent).toBe('unity-mcp');
  await key('Enter');
  expect(send.mock.calls[0][0]).toContain('/local/skills/unity/SKILL.md');
  expect(send.mock.calls[0][0]).toContain(skill.content);
  expect(send.mock.calls[0][0].split('\n\n')[0]).toBe('Please use');
});
it('navigates slash results with arrows and Tab, and Escape dismisses without changing text', async () => {
  skillHost(); await render(); await type('/'); await key('ArrowDown'); await key('Tab');
  expect(document.querySelector('[data-composer-skills]')?.textContent).toBe('review');
  await type('/unit'); await key('Escape');
  expect(document.querySelector('[role=listbox]')).toBeNull();
  expect(document.querySelector('textarea')?.value).toBe('/unit');
  expect(send).not.toHaveBeenCalled();
});
it('allows mouse selection, ignores URLs and does not send a query while results are empty', async () => {
  skillHost(); await render(); await type('https://example.com');
  expect(document.querySelector('[role=listbox]')).toBeNull();
  await type('/nonexistent'); await key('Enter'); expect(send).not.toHaveBeenCalled();
  await type('/unit'); await act(async () => { (document.querySelector('[role=option]') as HTMLElement).click(); });
  expect(document.querySelector('[data-composer-skills]')?.textContent).toBe('unity-mcp');
});
it('shows an explanation without the desktop bridge and keeps Enter safe while loading', async () => {
  await render(); await type('/');
  expect(document.querySelector('[role=status]')?.textContent).toBe('chatInput.skillsDesktopOnly');
  await key('Enter'); expect(send).not.toHaveBeenCalled();
});
it('does not send during loading and ignores late results after dismissal', async () => {
  let finish!: (value: []) => void;
  Object.assign(window, { __oaHost__: { listLocalSkills: () => new Promise(resolve => { finish = resolve; }) } });
  await render(); await type('/'); await key('Enter');
  expect(send).not.toHaveBeenCalled();
  expect(document.querySelector('[role=status]')?.textContent).toBe('chatInput.skillsLoading');
  await key('Escape'); await act(async () => finish([]));
  expect(document.querySelector('[role=listbox]')).toBeNull();
});

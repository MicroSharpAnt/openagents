'use client';

import * as React from 'react';
import { BookOpen } from 'lucide-react';
import { desktopHost, type LocalSkill, type LocalSkillGroup } from '@/lib/desktop-host';
import { useT } from '@/lib/i18n';

type SkillStatus = 'skillsDesktopOnly' | 'skillsLoadFailed' | 'skillsLoading' | 'skillsNoMatches' | null;
export interface SkillQuery { start: number; end: number; filter: string }
export function skillQueryAt(text: string, cursor: number): SkillQuery | null {
  const match = /(?:^|\s)\/([^\s/]*)$/.exec(text.slice(0, cursor));
  return match ? { start: cursor - match[1].length - 1, end: cursor, filter: match[1] } : null;
}

export function useSlashSkills(open: boolean, filter: string) {
  const [groups, setGroups] = React.useState<LocalSkillGroup[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  const supported = !!desktopHost()?.listLocalSkills;
  React.useEffect(() => {
    if (!open) return;
    let active = true;
    setGroups(null);
    setFailed(false);
    const load = desktopHost()?.listLocalSkills;
    if (load) load().then(value => { if (active) setGroups(value); }, () => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [open]);
  const needle = filter.toLocaleLowerCase();
  const items = (groups ?? []).flatMap(group => group.skills.map(skill => ({ ...skill, source: group.label })))
    .filter(skill => `${skill.name} ${skill.source} ${skill.description}`.toLocaleLowerCase().includes(needle));
  const status: SkillStatus = !supported ? 'skillsDesktopOnly' : failed ? 'skillsLoadFailed' : !groups ? 'skillsLoading' : !items.length ? 'skillsNoMatches' : null;
  return { items, status };
}

export function ComposerSlashSkills({ id, items, activeIndex, status, onPick }: {
  id: string;
  items: (LocalSkill & { source: string })[];
  activeIndex: number;
  status: SkillStatus;
  onPick: (skill: LocalSkill) => void;
}) {
  const t = useT();
  React.useEffect(() => { document.getElementById(`${id}-${activeIndex}`)?.scrollIntoView?.({ block: 'nearest' }); }, [id, activeIndex, items.length]);
  return <div className="absolute inset-x-0 bottom-full z-50 mb-2 max-h-70 overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10">
    <div className="px-2 py-1 text-xs text-muted-foreground">{t('chatInput.skills')} · {t('chatInput.skillsKeyboardHint')}</div>
    <div className="px-2 py-1 text-xs text-muted-foreground">{t('chatInput.skillsLocalHint')}</div>
    {status && <div role="status" className="px-2 py-3 text-sm text-muted-foreground">{t(`chatInput.${status}`)}</div>}
    <div id={id} role="listbox" aria-label={t('chatInput.skills')}>
      {items.map((skill, index) => <button type="button" role="option" id={`${id}-${index}`} aria-selected={activeIndex === index} key={`${skill.source}:${skill.path}`} title={skill.path}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted aria-selected:bg-muted"
        onMouseDown={event => event.preventDefault()} onClick={() => onPick(skill)}>
        <BookOpen className="size-4 shrink-0" />
        <span className="min-w-0 flex-1"><span className="block truncate text-sm">{skill.name}</span><span className="block truncate text-xs text-muted-foreground">{skill.description}</span></span>
        <span className="shrink-0 text-xs text-muted-foreground">{skill.source}</span>
      </button>)}
    </div>
  </div>;
}

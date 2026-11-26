'use client';

import { BookOpen, Check, Folder, X } from 'lucide-react';
import * as React from 'react';
import { desktopHost, type LocalSkill, type LocalSkillGroup } from '@/lib/desktop-host';
import { useT } from '@/lib/i18n';
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuPortal, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from '@/components/ui/dropdown-menu';

export function ComposerSkillMenu({ selected, onPick }: { selected: LocalSkill[]; onPick: (skill: LocalSkill) => void }) {
  const t = useT();
  const [groups, setGroups] = React.useState<LocalSkillGroup[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  const host = desktopHost();
  const load = async (open: boolean) => {
    if (!open || !host?.listLocalSkills) return;
    setFailed(false);
    setGroups(null);
    try { setGroups(await host.listLocalSkills()); } catch { setFailed(true); }
  };
  return <DropdownMenuSub onOpenChange={load}>
    <DropdownMenuSubTrigger><BookOpen />{t('chatInput.skills')}</DropdownMenuSubTrigger>
    <DropdownMenuPortal>
      <DropdownMenuSubContent className="min-w-60 max-w-80">
        <DropdownMenuLabel>{t('chatInput.skillsLocalHint')}</DropdownMenuLabel>
        {!host?.listLocalSkills ? <DropdownMenuItem disabled>{t('chatInput.skillsDesktopOnly')}</DropdownMenuItem>
          : failed ? <DropdownMenuItem disabled>{t('chatInput.skillsLoadFailed')}</DropdownMenuItem>
          : !groups ? <DropdownMenuItem disabled>{t('chatInput.skillsLoading')}</DropdownMenuItem>
          : groups.map(group => <DropdownMenuSub key={group.id}>
            <DropdownMenuSubTrigger><Folder />{group.label}<span className="ml-auto text-xs text-muted-foreground">{group.skills.length}</span></DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent className="max-h-80 w-80 overflow-y-auto">
                <DropdownMenuLabel className="break-all text-xs font-normal text-muted-foreground">{group.directories.join('\n')}</DropdownMenuLabel>
                {group.unavailable && <DropdownMenuItem disabled>{t('chatInput.skillsUnavailable')}</DropdownMenuItem>}
                {!group.skills.length && !group.unavailable && <DropdownMenuItem disabled>{t('chatInput.skillsEmpty')}</DropdownMenuItem>}
                {group.skills.map(skill => <DropdownMenuItem key={skill.path} title={`${skill.description}\n${skill.path}`} onSelect={() => onPick(skill)}>
                  <BookOpen className="shrink-0" />
                  <span className="min-w-0 flex-1"><span className="block truncate">{skill.name}</span>{skill.description && <span className="block truncate text-xs text-muted-foreground">{skill.description}</span>}</span>
                  {selected.some(item => item.path === skill.path) && <Check className="shrink-0" />}
                </DropdownMenuItem>)}
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>)}
      </DropdownMenuSubContent>
    </DropdownMenuPortal>
  </DropdownMenuSub>;
}

export function ComposerSkillChips({ skills, onRemove }: { skills: LocalSkill[]; onRemove: (path: string) => void }) {
  const t = useT();
  return <div className="flex flex-wrap gap-1.5" data-composer-skills>
    {skills.map(skill => <span key={skill.path} title={skill.path} className="inline-flex max-w-64 items-center gap-1 rounded-md border bg-muted/50 px-2 py-1 text-xs font-medium">
      <BookOpen className="size-3.5 shrink-0" /><span className="truncate">{skill.name}</span>
      <button type="button" className="rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`${t('common.remove')} ${skill.name}`} onClick={() => onRemove(skill.path)}><X className="size-3" /></button>
    </span>)}
  </div>;
}

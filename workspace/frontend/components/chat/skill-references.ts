import type { LocalSkill } from '@/lib/desktop-host';

/** Explicit user-selected references, readable by every coding agent and by teammates. */
export function withSkillReferences(message: string, skills: LocalSkill[]): string {
  if (!skills.length) return message;
  return [message, 'Selected local skills (read each instruction file before using it; if unavailable on your computer, report that):',
    ...skills.map(skill => `- ${JSON.stringify(skill.name)}: ${JSON.stringify(skill.path)}`),
  ].filter(Boolean).join('\n\n');
}

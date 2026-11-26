import type { LocalSkill } from '@/lib/desktop-host';

/** Carry selected instructions across devices without requiring the sender's filesystem. */
export function withSkillReferences(message: string, skills: LocalSkill[]): string {
  if (!skills.length) return message;
  return [message, 'Selected local skills: use the included instruction snapshots. Source paths refer to the sender’s computer and may not exist on yours. Referenced scripts, resources and tools are not included; report any missing dependencies.',
    ...skills.map(skill => {
      const reference = `- ${JSON.stringify(skill.name)}: ${JSON.stringify(skill.path)}`;
      if (typeof skill.content !== 'string') {
        return `${reference}\nInstruction content was not provided by this older desktop client. Read the source file only if accessible on your computer; otherwise ask the sender to update their desktop client and select the skill again.`;
      }
      // Keep embedded Markdown fences inside the instruction block.
      const longestFence = (skill.content.match(/`+/g) ?? []).reduce((longest, run) => Math.max(longest, run.length), 2);
      const fence = '`'.repeat(longestFence + 1);
      return `${reference}\n${fence}markdown\n${skill.content}\n${fence}`;
    }),
  ].filter(Boolean).join('\n\n');
}

import { expect, it } from 'vitest';
import { withSkillReferences } from './skill-references';

const skill = { name: 'review', path: '/sender/skills/review/SKILL.md', description: 'Review code' };

it('preserves a plain message without selected skills', () => {
  expect(withSkillReferences('Hello', [])).toBe('Hello');
});

it('includes complete Unicode instructions and safely contains embedded code fences', () => {
  const content = '---\nname: review\n---\n检查代码\n```sh\necho ok\n```\n';
  const result = withSkillReferences('Review this', [{ ...skill, content }]);
  expect(result).toContain(`\n\`\`\`\`markdown\n${content}\n\`\`\`\``);
  expect(result).toContain('Source paths refer to the sender');
  expect(result).toContain('resources and tools are not included');
});

it('explains missing content from old launchers without claiming it was transferred', () => {
  const result = withSkillReferences('', [skill]);
  expect(result).toContain(skill.path);
  expect(result).toContain('Instruction content was not provided');
  expect(result).toContain('update their desktop client');
});

it('keeps each selected skill paired with its own content, including empty files', () => {
  const result = withSkillReferences('', [{ ...skill, content: '' }, { ...skill, name: 'other', content: 'Other instructions' }]);
  expect(result).not.toContain('Instruction content was not provided');
  expect(result).toContain('```markdown\n\n```');
  expect(result).toContain('```markdown\nOther instructions\n```');
});

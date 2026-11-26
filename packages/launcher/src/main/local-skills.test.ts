// @vitest-environment node
import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { listLocalSkills } from './local-skills'

const homes: string[] = []
afterEach(async () => { for (const home of homes.splice(0)) await fs.rm(home, { recursive: true, force: true }) })
async function fixture() { const home = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-skills-')); homes.push(home); return home }
async function write(home: string, relative: string, content = '---\nname: example\ndescription: Test skill\n---\nInstructions') {
  const file = path.join(home, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); return file
}
it('discovers agent roots, system skills and flat Harness skills, deduplicating symlink aliases', async () => {
  const home = await fixture()
  const file = await write(home, '.codex/skills/test/SKILL.md')
  await write(home, '.codex/skills/.system/builtin/SKILL.md', 'Built in')
  await fs.mkdir(path.join(home, '.agents/skills'), { recursive: true })
  await fs.symlink(path.dirname(file), path.join(home, '.agents/skills/alias'))
  await write(home, '.claude/skills/review/SKILL.md', '---\nname: "Review"\n---\nReview code')
  await write(home, '.dsh/skills/flat.md', 'Flat skill')
  const groups = await listLocalSkills(home, {})
  expect(groups.map(g => g.label)).toEqual(['Codex', 'Claude', 'DeepSeek Harness'])
  expect(groups[0].skills.map(s => s.name)).toEqual(['builtin', 'example'])
  expect(groups[0].skills.find(s => s.name === 'example')).toEqual({ name: 'example', description: 'Test skill', path: file })
  expect(groups[1].skills[0].name).toBe('Review')
  expect(groups[2].skills[0].name).toBe('flat')
})
it('honors configured homes and handles missing roots without creating directories', async () => {
  const home = await fixture()
  const file = await write(home, 'custom/skills/task/SKILL.md')
  const groups = await listLocalSkills(home, { CODEX_HOME: path.join(home, 'custom'), DSH_HOME: ' ' })
  expect(groups[0].skills[0].path).toBe(file)
  expect(groups[1].skills).toEqual([])
  expect(groups[2].directories).toEqual([path.join(home, '.dsh/skills')])
  await expect(fs.stat(path.join(home, '.dsh'))).rejects.toMatchObject({ code: 'ENOENT' })
})
it('ignores oversized files and broken links, reporting unreadable roots', async () => {
  const home = await fixture()
  await write(home, '.codex/skills/large/SKILL.md', 'x'.repeat(262145))
  await fs.symlink('/nonexistent/skill', path.join(home, '.codex/skills/broken'))
  await write(home, '.claude/skills', 'not a directory')
  const groups = await listLocalSkills(home, {})
  expect(groups[0].skills).toEqual([])
  expect(groups[1].unavailable).toBe(true)
})

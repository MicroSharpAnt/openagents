import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export interface LocalSkill {
  name: string
  path: string
  description: string
  content: string
}
export interface LocalSkillGroup {
  id: string
  label: string
  directories: string[]
  skills: LocalSkill[]
  unavailable: boolean
}

/** Only enumerate known skill roots; renderer callers cannot supply filesystem paths. */
export async function listLocalSkills(home = os.homedir(), env = process.env): Promise<LocalSkillGroup[]> {
  const roots = [
    { id: 'codex', label: 'Codex', directories: [path.join(env.CODEX_HOME?.trim() || path.join(home, '.codex'), 'skills'), path.join(home, '.agents', 'skills')] },
    { id: 'claude', label: 'Claude', directories: [path.join(env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, '.claude'), 'skills')] },
    { id: 'deepseek', label: 'DeepSeek Harness', directories: [path.join(env.DSH_HOME?.trim() || path.join(home, '.dsh'), 'skills')] },
  ]
  return Promise.all(roots.map(async root => {
    const skills: LocalSkill[] = []
    const seen = new Set<string>()
    let unavailable = false
    async function add(file: string) {
      try {
        const real = await fs.realpath(file)
        if (seen.has(real)) return
        const stat = await fs.stat(real)
        if (!stat.isFile() || stat.size > 256 * 1024) return
        const text = await fs.readFile(real, 'utf8')
        const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] || ''
        const scalar = (key: string) => {
          const value = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(front)?.[1]?.trim() || ''
          return /^[>|]/.test(value) ? '' : value.replace(/^['"]|['"]$/g, '').slice(0, 300)
        }
        seen.add(real)
        skills.push({ name: scalar('name') || (path.basename(file) === 'SKILL.md' ? path.basename(path.dirname(file)) : path.basename(file, '.md')), path: file, description: scalar('description'), content: text })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unavailable = true
      }
    }
    async function scan(directory: string, system = false) {
      try {
        const entries = await fs.readdir(directory, { withFileTypes: true })
        for (const entry of entries.slice(0, 2000)) {
          if (entry.name === '.system' && root.id === 'codex' && !system) {
            await scan(path.join(directory, entry.name), true)
          } else if (!entry.name.startsWith('.')) {
            if (entry.isDirectory() || entry.isSymbolicLink()) await add(path.join(directory, entry.name, 'SKILL.md'))
            if (root.id === 'deepseek' && entry.isFile() && entry.name.endsWith('.md')) await add(path.join(directory, entry.name))
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unavailable = true
      }
    }
    for (const directory of root.directories) await scan(directory)
    return { ...root, skills: skills.sort((a, b) => a.name.localeCompare(b.name)), unavailable }
  }))
}

# Local skills in the desktop composer

In the source-built desktop client, open **+ → Skills → Codex / Claude / DeepSeek Harness** and select a skill. You can also type `/` at the start of a word in the composer, then type a skill name to filter the list. Use ↑/↓ to navigate, Enter or Tab to select, and Esc to dismiss. Selecting removes the `/query` and preserves the surrounding message. Selected skills appear as removable chips above the message. Repeated selections of the same file do not create duplicates. Sending includes the selected skill names and absolute instruction-file paths in the message, asking the agent to read them. It does not upload the skill directory or change any agent configuration.

The desktop host scans these user-level directories when the submenu opens:

| Category | Directories |
| --- | --- |
| Codex | `$CODEX_HOME/skills` (default `~/.codex/skills`, including `.system`) and `~/.agents/skills` |
| Claude | `$CLAUDE_CONFIG_DIR/skills` (default `~/.claude/skills`) |
| DeepSeek Harness | `$DSH_HOME/skills` (default `~/.dsh/skills`) |

Directory bundles contain `SKILL.md`; DeepSeek Harness also supports flat `.md` skills, consistent with its [filesystem provider](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/skill-filesystem/README.md). Symlinked bundles are supported and aliases to the same file are deduplicated within each category. Missing directories are not created. Unreadable directories show an error state.

This lists skills on the **client computer**, not on remote agents' computers. An agent running elsewhere must have access to the selected path to use it. Project-local skills and plugin catalogs are not included in this first version. Browsers and older desktop clients display an explanation instead of attempting local filesystem access.

The optional `listLocalSkills` host bridge accepts no path arguments, is restricted to hosted workspace views, and returns only skill metadata. Skill files over 256 KiB are ignored. Draft selections are kept separately for each conversation while the composer remains mounted; they clear on send or explicit removal, and are not persisted across application restarts.

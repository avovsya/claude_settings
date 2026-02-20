# Claude Code Configuration

Global configuration for [Claude Code](https://claude.ai/claude-code). Contains workflow recipes, agent instructions, and settings that apply across all projects.

## What's here

| File | Purpose |
|------|---------|
| `CLAUDE.md` | Agent-optimized workflow instructions (loaded into system prompt every session) |
| `CLAUDE_REFERENCE.md` | Human-readable companion with diagrams, examples, rationale |
| `settings.json` | Global Claude Code settings |
| `mcp.json.template` | MCP server config template (secrets redacted) |
| `coordinator/` | Persistent Node.js daemon — autonomous L1 coordinator (replaces Dispatcher session) |
| `mcp-servers/` | Custom MCP servers (tmux-control, session-bus) |
| `plans/` | Implementation plan documents |
| `skills/` | Claude Code skills (automated workflows invoked via `/skill-name`) |

## New machine setup

```bash
# 1. Clone into ~/.claude (must be empty or not exist)
git clone git@github.com:<your-username>/claude-config.git ~/.claude

# 2. Copy MCP template and fill in secrets
cp ~/.claude/mcp.json.template ~/.claude/mcp.json
# Edit ~/.claude/mcp.json — replace placeholder values with real API keys

# 3. Verify
claude --version
```

### If ~/.claude already exists (Claude Code was already installed)

```bash
# 1. Back up any existing config you want to keep
cp ~/.claude/settings.json /tmp/settings-backup.json

# 2. Clone the repo into a temp location
git clone git@github.com:<your-username>/claude-config.git /tmp/claude-config

# 3. Move git data into existing ~/.claude
mv /tmp/claude-config/.git ~/.claude/.git

# 4. Restore tracked files from repo (won't touch untracked/ignored files)
cd ~/.claude && git checkout .

# 5. Set up MCP secrets
cp ~/.claude/mcp.json.template ~/.claude/mcp.json
# Edit ~/.claude/mcp.json — replace placeholder values with real API keys

# 6. Clean up
rm -rf /tmp/claude-config
```

## Secrets

**Never commit `mcp.json`** — it contains API keys. Only `mcp.json.template` is tracked. The `.gitignore` uses a deny-by-default allowlist pattern so new files are ignored automatically.

## Updating

```bash
cd ~/.claude
git add -A
git commit -m "description of change"
git push
```

On other machines: `cd ~/.claude && git pull`

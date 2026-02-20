# Findings: Prompt Caching for Sub-Agents

**Task:** Investigate and document how to leverage Anthropic prompt caching when spawning sub-agents via Claude Code's Task tool.
**Date:** 2026-02-20
**Branch:** feature/prompt-caching
**Trello:** https://trello.com/c/b1P53yuj/9-4-prompt-caching-for-sub-agents

---

## Executive Summary

**The original hypothesis — that we can add `cache_control: { type: "ephemeral" }` to CLAUDE.md in sub-agent system prompts for 50% cost reduction — is not actionable.** Claude Code already handles prompt caching automatically on the main session, and sub-agents don't receive CLAUDE.md in their system prompts at all. The cost optimization opportunity is smaller than estimated but there are still practical improvements available through custom agents and prompt structuring.

---

## Question 1: Does Claude Code's Task tool already use prompt caching?

### Main Session: YES

Claude Code uses **automatic prompt caching** on the main conversation by default:

- System prompt (CLAUDE.md, rules files, tool definitions) is cached after the first turn
- Subsequent turns pay only **10% of input token cost** for the cached prefix
- Cache refreshes automatically on each use (5-minute TTL)
- This is built-in behavior requiring no user configuration

### Sub-Agents: NOT APPLICABLE (different architecture)

Each Task tool invocation creates a **separate, short-lived API conversation**:

- Sub-agents receive a small, specialized system prompt (200-600 tokens) specific to their type
- Built-in agent types and their approximate system prompt sizes:
  - **Explore:** ~516 tokens (read-only codebase exploration)
  - **Plan:** ~633 tokens (architecture planning)
  - **general-purpose:** ~294 tokens + ~127 tokens extra notes
- Sub-agents do **NOT** receive: parent CLAUDE.md, rules files, project context, or conversation history
- Each sub-agent is a fresh 1-turn conversation — there is no cross-agent cache sharing

**Key insight:** Since each sub-agent is an independent API call, prompt caching only applies *within* that single call. There's no mechanism to share cached state between separate sub-agent invocations.

---

## Question 2: Can we structure sub-agent prompts to trigger caching?

### Built-in Agents: NO

- Explore, Plan, and general-purpose agents have **fixed system prompts maintained by Anthropic**
- Users cannot modify these system prompts or add `cache_control` markers
- The prompts are small enough (200-600 tokens) that they fall **below caching thresholds** for most models:
  - Opus 4.6: 4,096 token minimum
  - Sonnet 4.6: 1,024 token minimum
  - Haiku 4.5: 4,096 token minimum

### Custom Agents: YES (partial opportunity)

Claude Code supports custom agent definitions in `.claude/agents/` or `~/.claude/agents/`:

```yaml
---
name: research-agent
description: Deep codebase research with project context
tools: Read, Grep, Glob, Bash
model: sonnet
---

[Custom system prompt goes here — can include project context, architecture docs, etc.]
```

- The markdown body becomes the agent's entire system prompt
- If this prompt exceeds the model's caching threshold, Claude Code's automatic caching could apply across multiple invocations of the same custom agent within a session
- **Limitation:** Custom agents cannot be used with the Task tool's built-in `subagent_type` parameter — they would need to be invoked differently

### Task Prompts: MINIMAL OPPORTUNITY

- The `prompt` parameter passed to the Task tool becomes a user message, not a system prompt
- Each sub-agent receives a unique task, so there's no repeated prefix to cache
- You could structure prompts with a large static preamble followed by task-specific instructions, but:
  - Each sub-agent is still a separate conversation
  - The preamble would need to exceed model-specific thresholds (1024-4096 tokens)
  - There's no guarantee Claude Code applies `cache_control` to user message content in sub-agent calls

---

## Question 3: What's the actual cost breakdown of a typical Phase 1 research session?

### Token Cost Model for 5 Parallel Explore Agents

| Component | Per Agent | 5 Agents | Cacheable? |
|-----------|-----------|----------|------------|
| System prompt (fixed) | ~516 tokens | 2,580 | No (below threshold, separate conversations) |
| Task prompt from parent | ~200-600 tokens | 1,000-3,000 | No (unique per agent) |
| Tool calls (file reads) | ~2,000-10,000 tokens | 10,000-50,000 | No (tool results, not prompt content) |
| Agent reasoning + output | ~1,000-3,000 tokens (output) | 5,000-15,000 | N/A (output tokens) |
| **Total input per session** | | **~13,580-55,580** | |

**Dominant cost driver:** Tool call results (file contents read by agents), NOT system prompts. This means prompt caching on system prompts would address only ~5-15% of sub-agent input costs even if it were possible.

### Main Session Caching (already optimized)

| Component | Tokens | Cached After Turn 1? |
|-----------|--------|----------------------|
| CLAUDE.md (project) | ~3,859 | YES (automatic) |
| CLAUDE.md (global) | ~3,859 (identical to project) | YES (deduplicated) |
| Rules files | ~545 | YES (automatic) |
| Tool definitions | ~2,000-5,000 | YES (automatic) |
| **Total system prompt** | **~6,400-9,400** | **YES** |

The main session already saves ~90% on these tokens after the first turn.

---

## Question 4: Are there Claude Code settings or environment variables for prompt caching?

### No user-facing caching controls exist

- Prompt caching is **automatic and always enabled** in Claude Code
- No environment variables to enable/disable/configure caching behavior
- No settings in `.claude/settings.json` for cache control

### Related settings (not caching-specific)

- `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`: Controls when auto-compaction triggers (default 95%)
- Model selection affects caching thresholds (Opus/Haiku need 4096 tokens; Sonnet needs 1024)

---

## What Would Need to Change (for the original vision to work)

For the 50% cost reduction on repeated doc reads across sub-agents, Claude Code would need:

1. **Shared cache context across sub-agent invocations** — A mechanism where multiple Task tool sub-agents within the same parent session share a prompt cache. This would require Claude Code to:
   - Maintain a cache key across sub-agent API calls
   - Prepend shared context (CLAUDE.md, architecture docs) to each sub-agent's system prompt with `cache_control` markers
   - This is an Anthropic engineering change, not a user-level optimization

2. **User-configurable sub-agent system prompts** — Allow users to inject additional system prompt content into built-in agent types. This partially exists via custom agents but isn't integrated with the Task tool's `subagent_type` parameter.

3. **Automatic context inheritance** — Sub-agents automatically receive (cached) parent context like CLAUDE.md, eliminating the need for each agent to independently read project docs via tool calls.

**Feature request reference:** [GitHub Issue #4908 — Scoped Context Passing for Subagents](https://github.com/anthropics/claude-code/issues/4908)

---

## Actionable Recommendations

### 1. No code changes needed (already optimized)

The main session's prompt caching already handles the largest cacheable content efficiently. No CLAUDE.md restructuring or additional `cache_control` markers are needed at the user level.

### 2. Custom agents for repeated patterns (optional, medium impact)

If you frequently spawn agents with identical large context blocks, consider creating custom agents in `~/.claude/agents/`:

```yaml
---
name: architecture-aware-explorer
description: Explore with full project architecture context
tools: Read, Grep, Glob
model: sonnet
---

## Project Architecture
[Include ARCHITECTURE.md content here]

## Key Patterns
[Include relevant patterns]

You are a codebase exploration agent with deep knowledge of this project's architecture...
```

This embeds project context in the system prompt where it CAN benefit from caching across invocations, instead of having each agent independently read architecture docs via tool calls.

### 3. Prompt structuring guidance (low impact, good practice)

When writing Task tool prompts, place shared/static context before task-specific instructions:

```
Good: "[Static architecture context...] Now investigate [specific task]"
Bad:  "Investigate [specific task]. Here's the architecture: [context...]"
```

This maximizes the cacheable prefix, though the benefit is limited since each sub-agent is a separate conversation.

### 4. Reduce redundant file reads across agents (medium impact, no caching needed)

Instead of spawning 5 Explore agents that each independently read the same 10 files, have the coordinator:
- Read shared context once
- Include relevant excerpts in each agent's Task prompt
- Give each agent a focused, non-overlapping scope

This reduces total token consumption by eliminating redundant tool calls, which is the actual dominant cost — not uncached system prompts.

### 5. Model selection optimization (cost reduction without caching)

- Use `model: "haiku"` for Explore agents (already default) — ~20x cheaper than Opus
- Reserve Opus for coordinator reasoning and complex implementation
- Sonnet for implementation agents where quality matters but cost should be controlled

---

## Revised Cost Impact Assessment

| Optimization | Estimated Savings | Actionable Now? |
|---|---|---|
| Main session prompt caching | Already active (~90% on system prompt) | Already done |
| Custom agents with embedded context | ~10-20% on agent input tokens | Yes (optional) |
| Reduce redundant file reads | ~20-30% on total sub-agent tokens | Yes (prompt discipline) |
| Shared cache across sub-agents | ~50% on repeated context | No (requires Claude Code changes) |
| Model selection | Up to 20x per agent (haiku vs opus) | Yes (already practiced) |

**Realistic achievable savings without Claude Code changes: 10-30% on sub-agent costs** through better prompt discipline and reduced redundant file reads.

**The 50% savings target** requires shared prompt caching across sub-agent invocations, which is an Anthropic platform feature, not a user-level optimization.

---

## References

- [Claude Code Sub-Agents Documentation](https://code.claude.com/docs/en/sub-agents)
- [Claude Code Cost Management](https://code.claude.com/docs/en/costs)
- [Anthropic Prompt Caching Documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [GitHub Issue #4908 — Scoped Context Passing for Subagents](https://github.com/anthropics/claude-code/issues/4908)
- [Piebald-AI Claude Code System Prompts](https://github.com/Piebald-AI/claude-code-system-prompts)
- `plans/MULTI_AGENT_ORCHESTRATION_ANALYSIS.md` Section 13, Item #4

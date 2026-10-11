# neatHack build log: Parallax

## Project

- **Name:** Parallax
- **Purpose:** an AI agency whose agents finish a research job end to end and check every answer from two independent angles before delivering it.
- **Problem:** research agents sound confident and are often wrong (stale headcount, a CEO who left last year, a "lead" who changed jobs). One source can't tell you it's wrong. Two independent sources that disagree can.

## Team

- neromtoobad (solo)

## Stack

- TypeScript, Node 24
- Models: neatHack LiteLLM gateway (claude-haiku, claude-sonnet-4.6, nova models)
- Tools: Crustdata APIs (company search/enrich, person search, web search, web fetch)
- neatlogs: traces for every job, agent step, tool call and model call
- Entire: checkpoints on every commit (branch `entire/checkpoints/v1`), entire-graph for code context
- cfo.ai: business plan (pricing, costs, revenue, runway) from measured unit economics

## Build log

### 2026-10-11

- Read the rules. Planned the idea: a two-angle research agency (Records vs Field, an Arbiter, a Verifier and a CFO).
- Created the repo. Enabled Entire (Claude Code hooks, branch checkpoints) and entire-graph (`entire graph init-agents`).
- Wrote the agent core (server/): checkpointed steps, CFO quotes and budget caps, the two-angle company brief and lead list, and neatlogs spans. Typechecks; it has not run against live APIs yet because the keys aren't in.
- Followed Entire's neatHack guide (hack.entire.io/neathacks-2026): installed Entire Brain (`entire brain init-agents`, `entire brain setup`, which indexed 24 files and 257 symbols) and added the brain MCP server in `.mcp.json`.
- The first build session started outside the repo, before Entire's hooks existed, so it wasn't captured. That transcript also includes unrelated private notes, so it was not attached as a public checkpoint. The build continues in a fresh session opened in the repo, so every prompt and commit from here on is captured.

## Demo

Pending.

## Known limitations and next steps

Pending.

## Submission

- [ ] Public repo with commits dated Oct 10–12
- [ ] Demo video, 3 min max, covering neatlogs, Entire and cfo.ai
- [ ] neatlogs traces: a before/after pair with numbers, and a recovery run
- [ ] Entire checkpoints / entire-graph output
- [ ] cfo.ai business plan (pricing, costs, revenue, runway)
- [ ] Building-in-public posts tagged #neatHack
- [ ] Quote-post the official neatlogs submission post (window: Oct 12, 7:00–11:55 PM IST)

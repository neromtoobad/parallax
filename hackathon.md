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

- First live job (company brief on Linear): it failed on a Crustdata 400 (a field name the API rejected), was fixed, then resumed from its checkpoint and delivered.
  - On the way it repaired a malformed model reply, and the Verifier rejected a web quote it could not find on the page, falling back to the database value.
  - Cost $0.161 against a $2 price.
  - neatlogs traces: `b0b16a50333cee82a2b6a842a258c667` (the failed run) and `313af6c8df2b296df7483c325d04f2ea` (the resumed run).
- Built the eval harness (`server/evals/cases.ts`, `scripts/eval.ts`, `scripts/compare.ts`): 7 company briefs with gold facts (founding year, CEO) and 2 lead lists. Every eval job is a normal traced job tagged `eval:<label>`.
- Ran the baseline eval `v1` and read its traces to find what to fix:
  - **The Verifier falsely rejected a correct CEO quote.** HTML-to-text drops spaces ("Karri SaarinenCo-founder"), so the quote check now ignores spacing.
  - **Field wasted credits on duplicate URLs** (`linear.app` and `linear.app/`) and on pages that block bots (Reddit). URLs are now canonicalised and those sites skipped.
  - **Field ran one fixed round of searches**, so facts missing after the first pass were never searched for. It now runs a second, targeted search per missing fact.
  - **The Writer padded the brief with guesses** ("likely", "will resonate"). The audit now rejects them.
- Web app (`web/`, Next.js): hire form with a CFO quote, a live job page (both angles side by side, verdicts, a streamed timeline, money against the budget cap, checkpoints, trace IDs), a jobs list, and a books page with eval comparisons.
  - Fixed live updates: Next's proxy gzip-buffered the event stream, so compression is now off for it.

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

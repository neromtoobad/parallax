# Parallax

**An AI agency that checks every answer from two angles.**

Research agents sound sure of themselves and are often wrong: stale headcounts, a CEO who left last year, a "lead" who changed jobs. One source can't tell you it's wrong. Two independent sources that disagree can.

Parallax is a team of agents you hire for a research job. They do the whole job, start to finish, and every fact is seen from two angles and checked at its source before it reaches you.

**Live: [useparallax.xyz](https://useparallax.xyz)**

> Built for [neatHack](https://neatlogs.com/hackathon), Oct 10–12 2026. Build log, evidence and submission checklist: [hackathon.md](hackathon.md).

## The team

| Agent | Job |
| --- | --- |
| **Lead** | Turns the client's brief into a work order: which company, what it's for, what they'll want to know. |
| **CFO** | Quotes the job from what past jobs of that kind really cost, measured call by call. Sets a hard budget the team cannot go past, and closes the books afterwards. |
| **Records** | The structured angle: Crustdata company and people databases. |
| **Field** | The open-web angle: searches and reads pages on its own, without seeing what Records found. Searches again for any fact still missing. |
| **Arbiter** | Lines the two angles up. On a disagreement it runs a tiebreak search and records why it chose. |
| **Verifier** | Plain code, no model: a web claim counts only if its quote is really on the page and really states the value. Rejects any draft line that guesses or uses a number not in the verified facts. |
| **Writer** | Writes the brief from verified facts only, each line citing them. |

## What you can hire it for

- **Company brief.** Before a sales call, pitch or partnership chat: what they do, when they were founded, HQ, headcount, funding, latest round, CEO. Then 4–6 points on what to do with that.
- **Lead list.** N companies that fit your ideal customer, each with the right person to contact. A lead ships only if:
  - the company's own site shows the fit, and the quote is on the page;
  - the database has the contact;
  - the open web doesn't say they left.

## Built to run without you watching

- **State.** Every unit of work is a checkpointed step saved to disk. A crashed or failed job resumes from its last finished step and pays for nothing twice. A lease stops two processes from working the same job.
- **Recovery.**
  - Crustdata 429s, 5xx and timeouts retry with backoff; other 4xx errors fail fast.
  - Malformed model replies go back to the model with the exact problem.
  - A failed search or fetch degrades to snippets instead of killing the job.
  - Fault injection (`PARALLAX_CHAOS="crust:0.3,llm-json:0.3"`) proves the recovery paths.
- **Budget.** Every model token and data credit is charged to the agent that spent it. At the cap the CFO stops the job (`paused`). A lead list delivers the leads it has verified so far and charges only for those.
- **Verification.** Quote-on-page checks, value-in-quote checks, citation and number audits on the written brief, and a database fallback when a web claim fails.

## How it uses the neatHack tools

- **neatlogs.**
  - Each job run is one `WORKFLOW` trace, labelled by service (`company-brief`, `lead-list`).
  - Inside it, every agent step is an `AGENT` span, every Crustdata call a `TOOL` span, and every model call an `LLM` span via `wrapOpenAI`.
  - Root spans carry `parallax.cost_usd`, `parallax.credits` and `parallax.price_usd`, so cost per job comes straight out of the traces.
  - The eval harness tags runs, so before/after versions can be compared trace by trace.
- **Entire.**
  - Checkpoints on every commit (branch `entire/checkpoints/v1`).
  - entire-graph and Entire Brain guide the coding agent (`.entire/agent-guide.md`, `.mcp.json`).
- **cfo.ai.** The business plan (pricing, costs, revenue, runway) is built from the unit economics the CFO agent measures. See [hackathon.md](hackathon.md).

## Evals

The same fixed jobs run on each version of the team (`server/evals/cases.ts`): 7 company briefs with gold facts, and 2 lead lists.

```bash
cd server
node --env-file=../.env scripts/eval.ts --label v2
node scripts/compare.ts v1 v2
```

Results are in `server/evals/results/`, and comparisons in `server/evals/*.md`. The Books page in the app also shows them.

## Run it

```bash
cp .env.example .env            # LITELLM_API_KEY, NEATLOGS_API_KEY, CRUSTDATA_API_KEY
cd server && npm install && npm start        # API on :8787
cd web && npm install && npm run dev         # app on :5180
```

The `Dockerfile` runs both in one container. `railway.json` deploys it.

## Stack

TypeScript, Node 24, Hono, Next.js 16. Models: the neatHack LiteLLM gateway (Claude Haiku for extraction, Claude Sonnet for judgement and writing). Data: Crustdata (company search and enrich, person search, web search, web fetch).

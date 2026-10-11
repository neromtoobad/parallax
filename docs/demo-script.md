# Demo script (3:00 max)

The rule: cover **neatlogs, Entire and cfo.ai**, all three on screen. One idea per scene. The voiceover lines are short so they fit the timing; read them, don't ad-lib.

App: https://useparallax.xyz

## Before recording

- [ ] **Browser:** 1280×800 window, light theme, zoom 100%, bookmarks bar hidden. Sign in to neatlogs, cfo.ai and GitHub first.
- [ ] **Tabs open, in order:**
  1. app home
  2. app hire page for company brief
  3. a delivered job page
  4. neatlogs trace of that job
  5. app Books
  6. GitHub repo, `entire/checkpoints/v1` branch
  7. terminal with `entire checkpoint list` and `entire graph impact` ready
  8. cfo.ai share link
- [ ] **Job to show live:** pick a company not used before (e.g. Resend, Clerk, PostHog). A brief takes about 80–100 s, so record the run in full, then speed it up 3–4× in the edit.
- [ ] **Recovery clip, recorded locally:**
  1. Start `npm run dev` in `server/` and the web app.
  2. Start a brief.
  3. After 3–4 steps, Ctrl+C the server, then restart it.
  4. The job page shows "Resumed (run 2); N finished steps kept".

  Optionally set `PARALLAX_CHAOS="crust:0.3"` so retries show in the activity feed.

## Scenes

| # | Time | On screen | Voiceover |
| --- | --- | --- | --- |
| 1 | 0:00–0:15 | Home hero: "Research you can actually trust" | "AI research agents sound sure of themselves and are often wrong. One source can't tell you it's wrong. Two independent sources that disagree can. That's Parallax." |
| 2 | 0:15–0:30 | Hire page: type a company and purpose, click Get a quote; CFO card shows $5 and a hard cap | "You hire it like an agency. The CFO agent quotes from what similar jobs really cost, and sets a hard budget nobody can spend past." |
| 3 | 0:30–1:00 | Job page, observatory animating (sped up); activity feed shows Records and Field working | "Seven agents. Records reads the databases. Field reads the open web. Neither sees the other's answer. When they disagree, the Arbiter goes looking for a tiebreak." |
| 4 | 1:00–1:20 | Results: "Two angles, side by side" table with *both agree* / *settled* verdicts; scroll to the write-up | "Every fact ships with where it came from. The Verifier checks each quote is really on the page, and the Writer's draft gets sent back if it guesses." |
| 5 | 1:20–1:45 | **neatlogs**: the job's trace, WORKFLOW → AGENT steps → TOOL calls (Crustdata) → LLM calls, with cost | "Every job is one neatlogs trace: each agent step, each data call, each model call. That's how we found what to fix…" |
| 6 | 1:45–2:00 | Books / `server/evals/v1-vs-v4.md` table | "…same nine test jobs, four versions. Guesswork in briefs: 39% to zero. Cost per verified lead: 12 cents to 7. Fourteen of fourteen known facts right, every version." |
| 7 | 2:00–2:20 | Recovery clip: kill server mid-job → restart → "Resumed (run 2); 6 finished steps kept" | "Every step is a checkpoint. Kill the server mid-job and it picks up where it stopped. Nothing gets paid for twice. This happened for real on production when a deploy hit a running job." |
| 8 | 2:20–2:40 | **Entire**: `entire checkpoint list`, the `entire/checkpoints/v1` branch on GitHub, then `entire graph impact step` showing all 7 services depend on it | "The build itself is checkpointed with Entire. Prompts and transcripts are linked to commits. Its code graph shows what breaks if we touch the checkpoint code." |
| 9 | 2:40–3:00 | **cfo.ai**: Cash and Hiring page, then the sensitivity table | "And the business: cfo.ai built the plan from our measured unit costs. 83% gross margin. The risk is data prices; the founder's salary is what needs a bridge. Parallax: research you can actually trust." |

## Numbers to say (all from the repo)

- **Eval v1 → v4** (`server/evals/v1-vs-v4.md`):
  - gold facts 14/14 right in every version;
  - guesswork 39% → 0%;
  - cost per verified lead $0.123 → $0.068;
  - facts seen from both angles 45% → 80%.
- **Production recovery:** job `job_mv3ikdo86bu0` resumed with 6 steps kept. neatlogs traces `1d2fd7e5…` (interrupted) and `c45a7838…` (resumed).
- **cfo.ai** (`docs/business-plan.md`):
  - gross margin 82.6%;
  - the Base case needs a ~$7.7k bridge and turns cash-flow positive in month 15;
  - with credits at $0.02, margin falls to 71.3%.

## Don't

- Show `.env`, API keys or the Railway variables page.
- Show the cfo.ai workspace sidebar, which shows another workspace name; use the share link instead.
- Claim the whole build is in Entire. The 07:15–09:52 commits have no checkpoints (`docs/entire/README.md`).

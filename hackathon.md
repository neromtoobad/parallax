# neatHack build log: Parallax

## Project

- **Name:** Parallax
- **Live:** https://useparallax.xyz (Railway)
- **Purpose:** an AI agency whose agents finish a research job end to end and check every answer from two independent angles before delivering it.
- **Problem:** research agents sound confident and are often wrong (stale headcount, a CEO who left last year, a "lead" who changed jobs). One source can't tell you it's wrong. Two independent sources that disagree can.

## Team

- neromtoobad (solo)

## Stack

- TypeScript, Node 24
- Models: neatHack LiteLLM gateway (claude-haiku, claude-sonnet-4.6, nova models)
- Tools: Crustdata APIs (company search/enrich, person search, web search, web fetch)
- neatlogs: traces for every job, agent step, tool call and model call
- Entire: checkpoints (branch `entire/checkpoints/v1`), entire-graph for code structure, Entire Brain for repo memory. Evidence: `docs/entire/`
- cfo.ai: business plan (pricing, costs, revenue, runway) from measured unit economics

## Build log

### 2026-10-11

- Read the rules. Planned the idea: a two-angle research agency (Records vs Field, an Arbiter, a Verifier and a CFO).
- Created the repo. Enabled Entire (Claude Code hooks, branch checkpoints) and entire-graph (`entire graph init-agents`).
- Wrote the agent core (server/): checkpointed steps, CFO quotes and budget caps, the two-angle company brief and lead list, and neatlogs spans. Typechecks; it has not run against live APIs yet because the keys aren't in.
- Followed Entire's neatHack guide (hack.entire.io/neathacks-2026): installed Entire Brain (`entire brain init-agents`, `entire brain setup`, which indexed 24 files and 257 symbols) and added the brain MCP server in `.mcp.json`.
- The first build session started outside the repo, before Entire's hooks existed, so it wasn't captured. That transcript also includes unrelated private notes, so it was not attached as a public checkpoint. The build was meant to continue in a session opened inside the repo. *Correction, added later the same day:* the sessions behind the 07:15–09:52 commits were also started from the parent folder, so they weren't captured either (see "Entire evidence" below).

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

- Lead-list fixes found by watching the v1 run:
  - **Bad candidates.** Semantic company search alone returned consultancies and courses. The search now uses hard headcount and country filters, and the database profiles are screened before any credits go on websites.
  - **Wrong contacts.** "CTO" substring-matched "Dire*cto*r", so a Senior Sales Director came back as a CTO lead. Titles now match on whole words, and the contact must hold the asked-for role or be a founder or C-level.
  - **Pages that wouldn't load.** Bot-check pages count as not loaded and get a browser-mode retry.
- Verifier fix: values naming several people. PostHog has two co-CEOs; the web said both and the database only one, and the old check wrongly rejected the web claim. Eval gold now accepts either co-CEO (posthog.com/about lists both).
- Two concurrency bugs, found when the API's crash recovery re-ran jobs the eval process was still working on:
  - **Leases.** A job carries the pid, host and time of its owner, and recovery only takes over a dead lease.
  - **Cache.** The job cache is keyed by file mtime, so a stale in-memory copy never looks abandoned.

### Eval v1 → v2 (same 9 fixed jobs; `server/evals/v1-vs-v2.md`)

| metric | v1 | v2 |
| --- | --- | --- |
| facts seen from both angles | 45% | **82%** |
| facts verified | 100% | 100% |
| gold facts right / wrong | 14/14, 0 wrong | 14/14, 0 wrong |
| brief points with guesswork | 39% | **0%** |
| avg cost per brief | $0.167 | $0.189 (more searching, by design) |
| leads delivered / wanted | 9/10 (one list hit its budget) | **10/10** |
| candidates checked per lead | 6.9 | **2.0** |
| cost per delivered lead | $0.123 | **$0.072** |
| avg seconds per lead list | 231 | **113** |

Trace IDs for every row are in `server/evals/v1-vs-v2.md`.

### Recovery on production (unplanned)

- Live job `job_mv3ikdo86bu0` on Railway (company brief, Paystack) was running when two git pushes redeployed the container mid-job.
- The new container logged "The server restarted mid-job; resuming from the last saved step" and resumed as run 2 with **6 finished steps kept** (nothing paid twice).
- It rode out a string of Crustdata 429s with backoff, then delivered: 7/7 facts verified, cost $0.204, price $2.
- neatlogs traces: `1d2fd7e5055c87cd1015ba1082e2572f` (interrupted), `c45a78388a7d892fec0af7443a2fecb8` (resumed).

### Business plan

- `server/scripts/unit-economics.ts` → `docs/unit-economics.md`: measured cost per brief and per lead from delivered jobs. Data is about 90% of the cost; models 6–13%.
- `docs/business-plan-brief.md`: pricing, assumptions, scenarios and the prompt for cfo.ai (Ari). cfo.ai's MCP server is in `.mcp.json`.
- Refreshed after v4. Unit costs now cover all seven services, measured on the current pipeline from 24 delivered jobs (`--tags eval:v4,dev`), and the brief prices every service.
- **The cfo.ai plan** (`docs/business-plan.md`; view-only model: https://cfo.ai/s/otTA-690Qi0JrZV0). Ari built a 24-month model in our cfo.ai workspace: Base, Growth and Downside scenarios, cash and hiring, and cost sensitivity. We checked its headline numbers with our own script and they match to the dollar.
  - **Gross margin** is about 83% after payment fees.
  - **The founder's salary causes a cash gap.** In the Base case, the $3,000/mo draw from month 7 runs out the $2,000 starting cash in month 9. The business needs a ~$7.7k bridge until it turns cash-flow positive again in month 15.
  - **First engineer:** only the Growth case can hire one, from month 10 at the earliest. Ari's safer pick is month 13.
  - **Data price risk:** if Crustdata credits cost $0.02 instead of $0.01, gross margin falls from 82.6% to 71.3%.

### Cheaper page reads (v3)

- Data is about 90% of the cost, so Parallax now reads pages with its own fetch first (free) and pays Crustdata only for pages that come back blocked or empty (`readPages` in `crust.ts`).
- Lead candidates whose domain doesn't resolve are skipped with a free DNS lookup before any page is paid for. The database still lists companies that are gone.
- Sharper candidate screening: law firms, foundations and accelerators are dropped too, and a company that *is* the kind of company asked for counts as a fit.
- Eval v3 (`server/evals/v2-vs-v3.md`): briefs saw 90% of facts from both angles (up from 82%), still 14/14 gold facts right. The lead lists got worse: 7/10 delivered. The Nigerian fintech list checked 26 candidates to verify 2 (trace `91f92175d4f0081f1a4d8cbe4fbdf102`).
- `docs/unit-economics.md` refreshed from 18 delivered jobs (v2, v3 and live tests).

### Five more services, three departments

- The catalog grew from 2 services to 7, grouped by department. Each one was run live with `scripts/try.ts` before it was committed:
  - **Sales:** `company-brief`, `lead-list`, `people-map`
  - **Market:** `competitor-teardown`, `market-map`
  - **Trust:** `vendor-check` (green/amber/red), `person-check`
- The new services return one generic `Deliverable` shape, and the code they share lives in `services/shared.ts`: candidate screening, checking a person on the open web, title ranking.
- Fixes found by running them:
  - "Former" flags now apply only to the person being checked.
  - Short company names get exact lookups.
  - Pricing checks need a quote from the page.
  - An empty web search is retried.
  - The CFO's quote has a floor for services with no cost history yet.
- Company briefs now fall back to a paid, rendered fetch when the free fetch gets a thin JavaScript shell (under 1,500 characters of text).

### UI overhaul

- **Observatory.** An illustrated scene where the 7 agents act out the real job events as they stream in (idle, work, talk, done). All art was generated for this project with Higgsfield, about 18 credits; the log is in `assets/art/CREDITS.md`.
- **Home:** a live replay of a real job, services by department, the team and proof numbers from the evals.
- **Hire:** the form, with the CFO's quote.
- **Job page:**
  - The subject is the title, with a one-line answer under it.
  - Results show "why" as a sentence, and internal flags are hidden.
  - A slim money and activity sidebar.
  - Saved steps and trace IDs are folded under "Under the hood".
- **Books:** client revenue is kept separate from test and eval runs. It covers every service.

### Eval v1 → v4 (same 9 fixed jobs; `server/evals/v1-vs-v4.md`)

| metric | v1 | v2 | v3 | v4 |
| --- | --- | --- | --- | --- |
| facts seen from both angles | 45% | 82% | 90% | 80% |
| gold facts right / wrong | 14/14, 0 | 14/14, 0 | 14/14, 0 | 14/14, 0 |
| brief points with guesswork | 39% | 0% | 0% | 0% |
| avg cost per brief | $0.167 | $0.189 | $0.201 | **$0.155** |
| leads delivered / wanted | 9/10 | 10/10 | 7/10 | **10/10** |
| candidates checked per lead | 6.9 | 2.0 | 4.6 | 2.8 |
| cost per delivered lead | $0.123 | $0.072 | $0.137 | **$0.068** |
| avg seconds per lead list | 231 | 113 | 178 | 141 |

- In v4 the Nigerian fintech list delivered 5/5 from 21 candidates (trace `1b553ddf3ffa5a0ce2a1478c4d25f320`), against 2/5 in v3. Between v3 and v4 the lead-list code only moved into shared helpers (plus de-duplicating candidates), so some of that swing is run-to-run variance on a hard case. Two lead lists is a small sample.
- Brief cost fell from $0.201 to $0.155 with the same gold-fact accuracy. "Facts seen from both angles" dipped from 90% to 80%.

### Entire evidence (`docs/entire/`)

- **Checkpoints.**
  - 5 checkpoints on `main` and 13 commits on `entire/checkpoints/v1`.
  - 4 captured sessions. Three are sub-agent sessions, attached at checkpoint `758532752575`: the background research and the build of the five newer services, about 28.6M tokens.
  - PII redaction (emails, phones) is on.
- **Gap, found while gathering this evidence.** The commits from 07:15 to 09:52 have no checkpoints. Their sessions were started from `~/Documents/Hacks`, not from inside the repo, so Entire's hooks never fired. Every session since 10:00 runs inside the repo and is captured. The rule is now a durable fact in the Brain.
- **Graph.** 76 files, 923 symbols, 2,476 relations.
  - A plain-English search ("resume a job from its last saved step after the server restarts") returns `step()`, `saveJob()` and `runJob()`, the real recovery path.
  - `impact` on `step()` shows all 7 service runners depend on it.
  - `commit` and `checkpoint` give entity-level diffs of the five-services commit and the business-plan checkpoint.
- **Graph usage, honestly.** `graph stats` counts 8 graph calls against 132 grep/find/read calls in the captured sessions. Discovery mostly went through grep; the graph was used for impact and change analysis.
- **Brain.**
  - The index was refreshed to HEAD, and its daemon re-indexes every 5 minutes.
  - Three durable facts were recorded and recalled: the session capture rule, the free-first page reads, and the CFO pricing rule.
  - The agent guides tell every coding agent to start with `entire brain brief`.

### Production check, and the HQ bug it found

- **End-to-end check on Railway.** A real company brief on Supabase went through quote, live run, both angles side by side, verdicts, write-up and the CFO's books. It was delivered in about 1.6 minutes for $0.165 against a $2 price, with 7/7 facts verified and 3 conflicts settled (trace `243dde8738e16400ad66976315600f01`).
- **Bug: the Arbiter picked the wrong headquarters.** The database said US and the web said San Francisco, but the Arbiter chose Singapore, because Supabase's terms of service name a Singapore legal entity. It treated "where it's incorporated" as "where it's based".
- **Fix:** the Arbiter now gets a definition with each fact it settles. For HQ, the definition says that place of incorporation is not the headquarters. Re-run locally, the same brief now says "based in San Francisco" (trace `efb2ad280d4a8817d9c3b87672c31d4c`).
- **Still open:** the Writer built on the bad HQ ("a presence in the Asia-Pacific market"). That's an inference the guesswork audit doesn't catch, because it only looks for hedging words.

## Demo

Pending.

## Known limitations and next steps

**Limitations**

- **Small samples.**
  - The eval has 7 company briefs and 2 lead lists.
  - The five newer services have 1–4 measured jobs each, so their unit costs are early estimates.
  - Some eval swings (v3 → v4 lead lists) are partly run-to-run variance.
- **Gold facts are narrow.** The eval checks founding year and CEO. Headquarters, headcount and funding aren't scored against known answers. That's how the HQ bug reached production before the live check caught it.
- **The Writer can still infer past the facts.** The guesswork audit catches hedging words ("likely", "may"), but not a confident inference built on a verified fact ("a presence in the Asia-Pacific market").
- **One Crustdata dependency.** Records is a single database. When it's wrong and the web is thin, the Arbiter has little to break the tie with.
- **No payments or accounts.** Jobs are quoted and "accepted" without taking money, and the Books revenue is what the jobs would have earned at their quoted prices. The production jobs are tagged test runs.
- **The Entire capture has a gap.** Commits from 07:15 to 09:52 on Oct 11 have no checkpoints (see `docs/entire/`).
- **The business plan is a model, not demand.** It leaves out acquisition spend and taxes, and the Growth scenario is a stretch.

**Next steps**

1. Wider gold facts in the eval (HQ, headcount, latest round), and an inference check in the Writer audit.
2. Payments (merchant of record) and client accounts, so Books shows real revenue.
3. A second structured data source, so Records isn't a single point of failure.
4. Re-price the newer services once each has 10+ delivered jobs; the CFO already re-prices from history automatically.
5. Ask Ari (cfo.ai) how long the founder draw can wait in the Base case, so the bridge is sized properly.

## Submission

- [x] Public repo with commits dated Oct 10–12: github.com/neromtoobad/parallax (public; all commits Oct 11)
- [ ] Demo video, 3 min max, covering neatlogs, Entire and cfo.ai
- [x] neatlogs traces: a before/after pair with numbers (`server/evals/v1-vs-v4.md`), and a recovery run, with screenshots in `docs/neatlogs/`
- [x] Entire checkpoints / entire-graph output: `docs/entire/` (gap: 07:15–09:52 commits uncaptured, explained there)
- [x] cfo.ai business plan (pricing, costs, revenue, runway): `docs/business-plan.md`, live model at https://cfo.ai/s/otTA-690Qi0JrZV0
- [ ] Building-in-public posts tagged #neatHack
- [ ] Quote-post the official neatlogs submission post (window: Oct 12, 7:00–11:55 PM IST)

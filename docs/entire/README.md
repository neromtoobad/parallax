# Entire evidence

How Parallax used Entire during neatHack. Every file in this folder is the raw output of the command named in it, captured on Oct 11 2026 at commit `982d5ab`.

## Checkpoints

- Entire is enabled for Claude Code. Its hooks attach an `Entire-Checkpoint:` trailer to each commit, and a plain `git push` uploads the session transcripts to the `entire/checkpoints/v1` branch on GitHub.
- PII redaction is on for emails and phone numbers (`.entire/settings.json`).
- Captured so far:
  - **5 checkpoints on `main`** ([`checkpoints.txt`](checkpoints.txt)). Each links a prompt and its session transcript to the commit it produced.
  - **13 commits on `entire/checkpoints/v1`** ([`checkpoints-branch-log.txt`](checkpoints-branch-log.txt)).
  - **4 sessions**: this session, plus 3 sub-agent sessions attached at checkpoint `758532752575`. Those three did the background research and built the five newer services, about 28.6M tokens between them.

**Gap.** The commits from 07:15 to 09:52 on Oct 11 have no checkpoints. That covers the agent core, the evals, the web app and the UI overhaul. The sessions that wrote them were started from the parent folder (`~/Documents/Hacks`), not from inside the repo, so Entire's hooks never fired. Their git history and commit dates are intact; only the transcripts weren't captured. Every session since then runs inside the repo and is captured. This rule is now a durable fact in the Brain (see below).

## Graph: code structure

entire-graph builds a local code graph with no network access: 76 files, 923 symbols and 2,476 relations.

- **[`graph-search-resume.txt`](graph-search-resume.txt).** We asked in plain English: "resume a job from its last saved step after the server restarts". It returned the exact mechanism, ranked:
  1. `step()`, the checkpointed, retried and traced unit of work;
  2. `saveJob()`, which writes atomically and holds the lease;
  3. `createJob()`;
  4. `runJob()`, which logs "Resumed (run N); K finished steps kept".
- **[`graph-impact-step.txt`](graph-impact-step.txt).** The blast radius of changing `step()`: all 7 service runners call it, and it depends on `neatlogs.span`, `saveJob` and `emit`. This is the check we run before touching the checkpoint code.
- **[`graph-commit-36bd7cb.txt`](graph-commit-36bd7cb.txt).** An entity-level diff of the "five new services" commit. It lists which functions changed and how many dependents each has, which a line diff doesn't show.
- **[`graph-checkpoint-39e19d483791.txt`](graph-checkpoint-39e19d483791.txt).** The semantic changes behind one Entire checkpoint: the cfo.ai business plan.
- **[`graph-stats.txt`](graph-stats.txt).** An honest usage report. Across the captured sessions the agent made 8 graph calls and 132 plain grep/find/read calls. Most code discovery still went through grep; the graph was used for blast-radius and change analysis.

## Brain: repo memory

- **[`brain-overview.txt`](brain-overview.txt).** The Brain's summary of the repo: commands, key documents and entry points. It's built from the code, docs, git history and captured sessions, and a background daemon keeps it fresh every 5 minutes.
- **Durable facts** recorded with `entire brain remember` ([`brain-recall.txt`](brain-recall.txt) shows them being recalled):
  - **Session capture rule** (`workflow.capture.rule`): agent sessions must start inside the repo, or their commits get no checkpoints.
  - **Page reads** (`architecture.data.cost`): our own fetch first; Crustdata is paid only for blocked or thin pages.
  - **CFO pricing** (`architecture.pricing.rule`): quotes use the 75th-percentile cost of the last 12 jobs at a 75% target margin, with a floor until a service has 3 jobs.
- `CLAUDE.md`, `AGENTS.md` and `.entire/agent-guide.md` tell every coding agent to start a task with `entire brain brief` and to use Graph for impact and diff checks.

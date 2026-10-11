# neatlogs evidence

Every Parallax job is one neatlogs trace:
- a `WORKFLOW` root per job run, named after its service;
- an `AGENT` span for each checkpointed step;
- a `TOOL` span for every Crustdata or web call;
- an `LLM` span for every model call, with token counts.

There are 80 traces in the project so far. Screenshots were taken from the neatlogs dashboard on Oct 11 2026.

## One job, end to end

[`trace-company-brief.jpg`](trace-company-brief.jpg) shows a company brief on Supabase, run on production (trace `243dde8738e16400ad66976315600f01`).
- 36 steps in 98 s.
- Lead plans the job, Records calls the Crustdata databases, Field runs web searches and page reads, then the Arbiter, Verifier and Writer take over.
- This run caught a real bug: the Arbiter picked a legal entity as the headquarters. The trace showed which tiebreak source it used, and the fix is in the build log.

## Crash recovery on production

A live job (company brief on Paystack, `job_mv3ikdo86bu0`) was running when two git pushes redeployed the container.

| | Trace | What it shows |
| --- | --- | --- |
| [`recovery-1-interrupted.jpg`](recovery-1-interrupted.jpg) | `1d2fd7e5055c87cd1015ba1082e2572f` | Run 1: Lead intake → Records → Field (web searches, page fetches, extractions) → Arbiter, then the container was replaced |
| [`recovery-2-resumed.jpg`](recovery-2-resumed.jpg) | `c45a78388a7d892fec0af7443a2fecb8` | Run 2 (`Run: 2` in the input) starts at the Arbiter's tiebreaks. Intake, Records and Field are **not** re-run, because their checkpointed results were kept. It ends with the Verifier and Writer and delivers 7/7 facts verified for $0.204 |

## Before and after

The eval runs are traced and tagged `eval:v1` … `eval:v4`, and every eval job's trace ID is listed in `server/evals/v1-vs-v4.md`. Reading the v1 traces is how we found:
- the Verifier rejecting a correct quote (spacing lost in HTML-to-text);
- Field paying twice for duplicate URLs;
- one-pass searches that left facts missing;
- a Writer that padded briefs with guesses.

## Detections

neatlogs flagged two of this morning's production jobs as **Execution Failed**, though both delivered:
- **People map on Linear** (trace `cc419daffbf780171c90c856fbe1cc39`). One `crustdata.web_search` errored after 39.4 s while checking one person on the web. The job carried on: that person was kept on the database's word and reported as not web-confirmed ("4 of 5 confirmed on the open web").
- **Vendor check on stripe.com** (`job_mv3o65hg0naz`). Also flagged; it delivered green, with 12 of 13 checks passed.

**What the trace led to.** The job's activity log showed the real cause: Crustdata rate limits (three 429s in a row while 7 test jobs shared the key), not a timeout. Two fixes, both shipped:

- **Longer retries on rate limits.** On 429s, Crustdata calls now retry up to 6 times (about 90 s) instead of 4.
- **A false "server restarted" message.** The same log showed "The server restarted mid-job" with no restart. The once-a-minute recovery check treated a job this process was still running as abandoned, because a new container usually reuses pid 1. Nothing ran twice, but the message was wrong. Recovery now skips jobs the process is actively running. Checked locally with a 124 s job: no false recovery events.

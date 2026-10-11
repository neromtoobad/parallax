# Parallax

An AI agency that checks every answer from two angles. Entry for neatHack (neatlogs.com/hackathon), Oct 10–12 2026.
Build log and submission checklist: `hackathon.md` (keep it updated after each work session, dated entries, evidence links only).

## How it works

- `server/` — Hono API on Node 24, `.ts` run directly (no build). `npm run dev` from `server/` (port 8787, reads `../.env`).
- A **job** = one neatlogs `WORKFLOW` trace (`runner.ts`). Each unit of work is a checkpointed `step()` (`context.ts`): saved to `data/jobs/<id>.json`, skipped on resume, retried with backoff, traced as an `AGENT` span. Crustdata calls are `TOOL` spans (`crust.ts`); model calls go through `wrapOpenAI` (`llm.ts`).
- Agents: Lead (intake/plan), CFO (`agents/cfo.ts`: quote from past cost per unit, hard budget, books), Records (Crustdata database), Field (Crustdata web search + fetch), Arbiter (conflict tiebreak), Verifier (quote-on-page + value checks, plain code in `agents/compare.ts`), Writer.
- Services (`catalog.ts`, each with a `dept`): sales = `company-brief`, `lead-list`, `people-map`; market = `competitor-teardown`, `market-map`; trust = `vendor-check`, `person-check`. Newer services return the generic `Deliverable` shape (`types.ts`); shared helpers live in `services/shared.ts`. Try one live: `node --env-file=../.env scripts/try.ts <service> '<json>'` (or `--resume <jobId>`).
- Spend is charged per call (`charge()`); `assertBudget()` stops a job at its cap → status `paused`, resumable via `/api/jobs/:id/approve`.
- Fault injection for recovery demos: `PARALLAX_CHAOS="crust:0.3,llm-json:0.3"`.

## Rules that matter

- All code must be written during the hackathon (Oct 10–12). Commits are judged for dates.
- Must use neatlogs (tracing), Entire (checkpoints/graph/brain) and cfo.ai (business plan). Demo ≤3 min covering all three.
- Push with plain `git push` (the pre-push hook uploads Entire checkpoints). Commit messages: no AI co-author or "generated with" lines.
- Never commit `.env` or keys. Never put keys, personal data or private traces in `hackathon.md`.

## Next up

1. Run real jobs once `.env` has LITELLM_API_KEY, NEATLOGS_API_KEY, CRUSTDATA_API_KEY; fix Crustdata field mappings against live responses.
2. Eval harness (`server/scripts/eval.ts`): fixed set of briefs, score verified-facts / lead precision / cost / latency, tagged runs → before/after numbers from neatlogs traces.
3. Web app (`web/`): hire form → CFO quote → live job view (two angles side by side, conflicts, checks, money) → books page.
4. Deploy (Railway), demo video, cfo.ai plan from measured unit economics.

<!-- entire-agent:begin -->
Read .entire/agent-guide.md for this repository's workflow, source inspection, and verification guidance.
@.entire/agent-guide.md
<!-- entire-agent:end -->

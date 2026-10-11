# Parallax

**An AI agency that checks every answer from two angles.**

You hire Parallax for a research job (a company brief before a sales call, or a verified lead list).
A team of agents does the whole job, start to finish:

1. **Lead** turns your brief into a plan and acceptance criteria.
2. **CFO** quotes the job from what past jobs really cost (measured in neatlogs traces) and sets a hard budget.
3. Two analysts work the job **independently**, from different angles:
   - **Records** reads structured company and people data (Crustdata).
   - **Field** reads the open web (search + the company's own pages).
4. **Arbiter** lines up both answers. Where they disagree, it goes and finds a tiebreaker.
5. **Verifier** checks every claim against its source before anything is delivered. Failed checks go back for rework.
6. **CFO** closes the books: quote vs. actual cost, margin, and where the money went.

Like parallax in astronomy: one viewpoint can't tell you how far away a star is. Two can.

> Built for [neatHack](https://neatlogs.com/hackathon) (Oct 10–12, 2026). Build log: [hackathon.md](hackathon.md).

## Stack

- Agents: TypeScript on Node 24, models through the neatHack LiteLLM gateway (Claude + Nova)
- Tools: Crustdata (company search/enrich, people search, web search, web fetch)
- Tracing: [neatlogs](https://neatlogs.com) on every job, agent, tool call and model call
- Coding-agent context: [Entire](https://entire.io) checkpoints + entire-graph
- Business plan: [cfo.ai](https://cfo.ai), built from unit economics measured in neatlogs traces

## Run it

```bash
cp .env.example .env   # add your keys
cd server && npm install && npm run dev
```

More soon.

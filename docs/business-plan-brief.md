# Parallax: business plan brief (input for cfo.ai)

This is the input we hand to cfo.ai (Ari) to build Parallax's financial model: pricing, costs, revenue and runway.
The unit costs are **measured**, not guessed: every model call and every Crustdata call in a job is metered as it happens, and the same calls appear as spans in that job's neatlogs trace.
Measured numbers live in [`unit-economics.md`](unit-economics.md); regenerate them with `node server/scripts/unit-economics.ts`.
Everything else below is an **assumption**, marked as such, for Ari to model and stress.

## The business

Parallax is an AI research agency for sales, partnerships and investing teams. Customers hire it per job:

- **Company brief.** Everything to know before a meeting, with every fact checked from two angles.
- **Lead list.** Companies that fit an ideal customer profile, each with the right person to contact, verified from two angles.

Customers are founders, SDRs/AEs, partnership leads and investors at small and mid-size companies.
The wedge is trust: other research agents hand you confident text, while Parallax shows where each fact came from and what it checked.

## Measured unit costs (from delivered eval jobs, Oct 11 2026)

| | Company brief | Lead list |
| --- | --- | --- |
| Cost per unit, median | $0.168 per brief | $0.095 per delivered lead |
| Cost per unit, p75 (used for pricing) | $0.195 | $0.158 |
| Share of cost: data (Crustdata) / models | 87% / 13% | 94% / 6% |
| Crustdata credits per unit | 15.4 | 9.6 |
| Time per job, median | ~2 min | ~3.5 min for 5 leads |

These come from the v1 and v2 eval runs; they will be updated with v3 and live jobs.

**Cost drivers:**
- Data is about 90% of the variable cost. The model bill is small because extraction runs on Claude Haiku and only judgement and writing use Sonnet.
- The biggest lever is the Crustdata credit price (assumed below) and how many web searches and page reads each job makes.

## Pricing (proposal)

| Plan | Price | Includes | Gross margin at p75 cost |
| --- | --- | --- | --- |
| Pay as you go: company brief | **$5 per brief** | – | 96% |
| Pay as you go: lead list | **$1 per verified lead** (you pay only for leads that pass) | – | 84% |
| Team (monthly) | **$99/mo** | 30 briefs + 150 verified leads | 70% if fully used; ~80% at typical 60% use |
| Pro (monthly) | **$299/mo** | 100 briefs + 500 verified leads | 67% if fully used |

The CFO agent prices each job from the 75th percentile of measured cost, at a 75% target margin. The public prices above sit well over that floor.

## Assumptions (for Ari to model; change freely)

| Assumption | Base | Notes |
| --- | --- | --- |
| Crustdata cost per credit | $0.01 | Not published (sales-led pricing). Sensitivity: $0.005 / $0.02. |
| Model prices | list prices | Claude Haiku $1/$5 and Sonnet $3/$15 per M tokens (the hackathon gateway is free; production would pay these). |
| Hosting (Railway) | $20/mo | One container and a volume; grows with load. |
| Tracing (neatlogs) | $0 at first | Free tier is 100k spans/mo, and a job is about 30–80 spans, so roughly 1,500+ jobs/mo before upgrading. |
| Domain and email | $5/mo | |
| Payments | 5% of revenue | Merchant-of-record fee (e.g. Dodo Payments). |
| Founder | solo, no salary for the first 6 months | Then $3,000/mo. |
| Starting cash | $2,000 | Placeholder; set to real number. |

### Customer assumptions

| Scenario | Month 1 paying customers | Monthly growth | Mix | Monthly churn |
| --- | --- | --- | --- | --- |
| Base | 5 | 25% | 60% pay-as-you-go ($25/mo avg), 35% Team, 5% Pro | 6% |
| Growth | 10 | 40% | same | 4% |
| Downside | 3 | 10% | 80% pay-as-you-go | 10% |

## What we want from the model

1. A 24-month operating model per scenario: revenue by plan, variable cost (data + models + payment fees), gross margin, fixed costs, operating income, ending cash.
2. Runway in months for each scenario, and the month the business turns cash-flow positive.
3. Sensitivity of gross margin to the Crustdata credit price ($0.005 / $0.01 / $0.02) and to plan utilisation (40% / 60% / 100%).
4. When we can afford the first hire (a $5,000/mo engineer) without dropping below 6 months of runway.

## Prompt to paste into Ari

> Build a 24-month financial model for Parallax, an AI research agency that sells verified company briefs and lead lists to sales, partnership and investing teams. Use this unit economics:
> - a company brief costs us $0.195 to deliver (75th percentile, measured over real jobs; 87% data, 13% models);
> - a verified lead costs us $0.158 (94% data).
>
> Pricing:
> - $5 per brief pay-as-you-go;
> - $1 per verified lead;
> - Team plan $99/mo including 30 briefs + 150 leads;
> - Pro plan $299/mo including 100 briefs + 500 leads.
>
> Assume 60% plan utilisation, 5% payment fees, and fixed costs of $25/mo (hosting, domain), rising to $3,025/mo from month 7 when the founder starts drawing $3,000/mo. Starting cash $2,000. Model three scenarios:
> - **Base:** 5 customers in month 1, 25% monthly growth, 6% churn, mix 60% pay-as-you-go averaging $25/mo, 35% Team, 5% Pro.
> - **Growth:** 10 customers, 40% growth, 4% churn.
> - **Downside:** 3 customers, 10% growth, 10% churn, 80% pay-as-you-go.
>
> Show monthly revenue, gross margin, operating income, ending cash and runway per scenario, and the month each turns cash-flow positive. Add a sensitivity table of gross margin against data cost per credit ($0.005, $0.01, $0.02; base case is $0.01 and 15.4 credits per brief, 9.6 per lead) and plan utilisation (40%, 60%, 100%). Finally, tell me the earliest month we can hire a $5,000/mo engineer and keep at least 6 months of runway.

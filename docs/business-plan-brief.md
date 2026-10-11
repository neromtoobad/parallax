# Parallax: business plan brief (input for cfo.ai)

This is the input we hand to cfo.ai (Ari) to build Parallax's financial model: pricing, costs, revenue and runway.
The unit costs are **measured**, not guessed. Every model call and every Crustdata call in a job is metered as it happens, and the same calls appear as spans in that job's neatlogs trace.
The measured numbers live in [`unit-economics.md`](unit-economics.md). Regenerate them with `node server/scripts/unit-economics.ts --tags eval:v4,dev`.
Everything else below is an **assumption**, marked as such, for Ari to model and stress.

## The business

Parallax is an AI research agency for sales, partnerships and investing teams. Customers hire it per job, from seven services in three departments:

| Dept | Service | What the client gets |
| --- | --- | --- |
| Sales | **Company brief** | Everything to know before a meeting, every fact checked from two angles |
| Sales | **Lead list** | Companies that fit an ideal customer profile, each with the right person to contact, verified |
| Sales | **People map** | Who's who at a company: decision makers, verified to still be there |
| Market | **Competitor teardown** | A competitor's product, pricing, positioning and team, with quotes from their own pages |
| Market | **Market map** | The companies in a space, screened and checked |
| Trust | **Vendor check** | Is this vendor real and still operating? Green, amber or red, with the reasons |
| Trust | **Person check** | Does this person hold the role they claim, at the company they claim? |

Customers are founders, SDRs/AEs, partnership leads and investors at small and mid-size companies.
The wedge is trust. Other research agents hand you confident text; Parallax shows where each fact came from and what it checked.

## Measured unit costs (Oct 11 2026, current pipeline)

These come from delivered jobs on the current code: the v4 eval plus live test runs of the newer services.

| Service | Unit | Jobs measured | Cost per unit, median | p75 (used for pricing) | Data / models | Crustdata credits per unit |
| --- | --- | --- | --- | --- | --- | --- |
| Company brief | brief | 9 | $0.150 | **$0.161** | 79% / 21% | 12.3 |
| Lead list | verified lead | 6* | $0.096 | **$0.116*** | 93% / 7% | 11.1 |
| People map | job | 3 | $0.112 | **$0.114** | 92% / 8% | 10.0 |
| Competitor teardown | job | 4 | $0.184 | **$0.249** | 72% / 28% | 13.5 |
| Market map | company mapped | 1 | $0.021 | **$0.021** | 87% / 13% | 1.9 |
| Vendor check | job | 3 | $0.012 | **$0.082** | 96% / 4% | 3.3 |
| Person check | job | 2 | $0.046 | **$0.046** | 94% / 6% | 3.3 |

\* Lead lists use the v2–v4 evals (6 lists), not v4 alone (2 lists). That's more conservative, because it includes a v3 list that had to check 26 candidates to verify 2.

The newer services have small samples (1–4 jobs), so treat their costs as early estimates. In the app, the CFO agent re-prices every service from its last 12 delivered jobs, so these numbers improve with use.

**Cost drivers:**
- Data is 72–96% of the variable cost. The model bill is small because extraction runs on Claude Haiku, and only judgement and writing use Sonnet.
- The biggest lever is the Crustdata credit price (assumed below). Parallax reads pages with its own fetch first (free) and pays Crustdata only for pages that block it. That change took a brief from $0.201 (v3) to $0.155 (v4) with the same accuracy.
- How it improved over four eval versions (`server/evals/v1-vs-v4.md`):
  - cost per delivered lead fell from $0.123 to $0.068;
  - gold facts stayed 14/14 right in every version;
  - brief points with guesswork fell from 39% to 0%.

## Pricing (proposal)

| Plan | Price | Includes | Gross margin at p75 cost |
| --- | --- | --- | --- |
| Pay as you go: company brief | **$5 per brief** | – | 97% |
| Pay as you go: lead list | **$1 per verified lead** (you pay only for leads that pass) | – | 88% |
| Pay as you go: people map | **$3** | – | 96% |
| Pay as you go: competitor teardown | **$5** | – | 95% |
| Pay as you go: market map | **$3 per 10 companies** | – | 93% |
| Pay as you go: vendor check | **$2** | – | 96% |
| Pay as you go: person check | **$1** | – | 95% |
| Team (monthly) | **$99/mo** | 30 briefs + 150 verified leads | 78% if fully used; 87% at 60% use |
| Pro (monthly) | **$299/mo** | 100 briefs + 500 verified leads | 75% if fully used; 85% at 60% use |

- In the Team and Pro plans, the other services draw on the brief allowance. A people map, competitor teardown, market map or vendor check uses 1 brief, and a person check uses half of one. A teardown costs more than a brief ($0.249 against $0.161), so heavy teardown use lowers plan margins a little.
- Gross margins above are before payment fees.
- The CFO agent prices each one-off job from the 75th percentile of measured cost at a 75% target margin. The public prices above sit well above that floor.

## Assumptions (for Ari to model; change freely)

| Assumption | Base | Notes |
| --- | --- | --- |
| Crustdata cost per credit | $0.01 | Not published (sales-led pricing). Sensitivity: $0.005 / $0.02. |
| Model prices | list prices | Claude Haiku $1/$5 and Sonnet $3/$15 per million tokens. The hackathon gateway is free; production would pay list prices. |
| Hosting (Railway) | $20/mo | One container and a volume; grows with load. |
| Tracing (neatlogs) | $0 at first | The free tier is 100k spans/mo, and a job is about 30–80 spans, so roughly 1,500+ jobs/mo before upgrading. |
| Domain and email | $5/mo | |
| Payments | 5% of revenue | Merchant-of-record fee (e.g. Dodo Payments). |
| Founder | solo, no salary for the first 6 months | Then $3,000/mo. |
| Starting cash | $2,000 | Placeholder; set to the real number. |

### Customer assumptions

| Scenario | Month 1 paying customers | Monthly growth | Mix | Monthly churn |
| --- | --- | --- | --- | --- |
| Base | 5 | 25% | 60% pay-as-you-go ($25/mo avg), 35% Team, 5% Pro | 6% |
| Growth | 10 | 40% | same | 4% |
| Downside | 3 | 10% | 80% pay-as-you-go | 10% |

## What we want from the model

1. A 24-month operating model per scenario, covering:
   - revenue by plan;
   - variable cost (data, models and payment fees) and gross margin;
   - fixed costs, operating income and ending cash.
2. Runway in months for each scenario, and the month the business turns cash-flow positive.
3. Sensitivity of gross margin to the Crustdata credit price ($0.005 / $0.01 / $0.02) and to plan utilisation (40% / 60% / 100%).
4. When we can afford the first hire (a $5,000/mo engineer) without dropping below 6 months of runway.

## Prompt to paste into Ari

> Build a 24-month financial model for Parallax, an AI research agency that sells verified research to sales, partnership and investing teams: company briefs, lead lists, people maps, competitor teardowns, market maps, vendor checks and person checks.
>
> Unit economics, measured over real jobs (75th percentile):
> - a company brief costs us $0.161 to deliver (79% data, 21% models);
> - a verified lead costs us $0.116 (93% data);
> - a competitor teardown costs $0.249;
> - a people map costs $0.114;
> - a vendor check costs $0.082;
> - a person check costs $0.046;
> - a market map costs $0.021 per company.
>
> Pricing:
> - pay-as-you-go: $5 per brief, $1 per verified lead, $3 per people map, $5 per teardown, $3 per 10-company market map, $2 per vendor check, $1 per person check;
> - Team plan: $99/mo including 30 briefs + 150 leads;
> - Pro plan: $299/mo including 100 briefs + 500 leads;
> - in the plans, the other services draw on the brief allowance.
>
> Costs and cash: assume 60% plan utilisation and 5% payment fees. Fixed costs are $25/mo (hosting, domain), rising to $3,025/mo from month 7 when the founder starts drawing $3,000/mo. Starting cash is $2,000.
>
> Model three scenarios:
> - **Base:** 5 customers in month 1, 25% monthly growth, 6% churn, mix 60% pay-as-you-go averaging $25/mo, 35% Team, 5% Pro.
> - **Growth:** 10 customers, 40% growth, 4% churn.
> - **Downside:** 3 customers, 10% growth, 10% churn, 80% pay-as-you-go.
>
> For each scenario, show monthly revenue, gross margin, operating income, ending cash and runway, and the month it turns cash-flow positive.
>
> Add a sensitivity table of gross margin against data cost per credit and plan utilisation:
> - data cost per credit: $0.005, $0.01, $0.02 (base case $0.01, with 12.3 credits per brief and 11.1 per lead);
> - plan utilisation: 40%, 60%, 100%.
>
> Finally, tell me the earliest month we can hire a $5,000/mo engineer and keep at least 6 months of runway.

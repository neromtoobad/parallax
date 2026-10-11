# Parallax: business plan (cfo.ai)

Built by Ari (cfo.ai) on Oct 11 2026 from [`business-plan-brief.md`](business-plan-brief.md), which uses unit costs measured from real jobs ([`unit-economics.md`](unit-economics.md)).
**Live model (view-only): https://cfo.ai/s/otTA-690Qi0JrZV0.** It has four pages: Assumptions, Customers and Revenue, Cash and Hiring, and Cost Sensitivity. The link opens on the main scenario, and the Growth and Downside scenarios are in the same model.
It runs 24 months, from October 2026 to September 2028.

**Independent check.** We recomputed the three scenarios in a short script using the same conventions. Ari's headline numbers match ours to the dollar:
- month-24 revenue $17,652 / $761,425 / $134 (Base / Growth / Downside);
- Base's $7,716 funding gap;
- Base cash-flow positive again in month 15.

## Results before hiring

| | Base | Growth | Downside |
| --- | --- | --- | --- |
| Month 24 monthly revenue | $17,652 | $761,425 | $134 |
| Gross margin (after delivery costs and 5% payment fees) | 82.6% | 82.6% | 84.0% |
| Month 24 operating income | $11,557 | $626,002 | −$2,912 |
| Month 24 ending cash | $37,327 | $2,322,242 | −$49,890 |
| First cash shortfall | month 9 | none | month 7 |
| Extra funding needed to stay above $0 | $7,716 | $0 | $49,890 |
| Cash-flow positive (from month 7, after the founder draw starts) | month 15 (Dec 2027) | throughout | never |

All three scenarios are cash-flow positive in months 1–6, before the founder draws a salary.

## What it says

- **The unit economics are strong.** Gross margin is about 83% after payment fees.
- **The founder's salary is what causes the cash gap.** In the Base case, a $3,000/mo draw from month 7 runs the $2,000 starting cash out in month 9. It needs a bridge of about $7.7k before profits return in month 15. The fix is to delay the draw, raise a small bridge, or grow faster.
- **First engineer ($5,000/mo):**
  - Only Growth can afford one. The earliest month is month 10 (July 2027), when the hire still leaves 6+ months of runway.
  - Ari's safer recommendation is month 13 (October 2027), when Growth also holds six months of fixed costs ($48,150) in cash.
  - Base and Downside can't fund the hire as modelled.
- **The data price is the biggest risk.** At 60% plan use, gross margin falls from 82.6% to 71.3% if Crustdata credits cost $0.02 instead of $0.01.

## Gross-margin sensitivity (Base mix, after payment fees)

| Data cost per credit | 40% plan use | 60% plan use | 100% plan use |
| --- | --- | --- | --- |
| $0.005 | 90.2% | 88.3% | 84.4% |
| $0.010 | 86.2% | **82.6%** | 75.5% |
| $0.020 | 78.1% | 71.3% | 57.7% |

## Assumptions and limits

- Customers change each month by acquisition minus churn: 19% net growth in Base, 36% in Growth and 0% in Downside.
- **Growth is a stretch case**, not validated demand: it reaches about 11.8k customers by month 24.
- Pay-as-you-go revenue is split 50/50 between briefs and leads. In the plans, the other services use the brief allowance.
- Not included:
  - acquisition spend;
  - manual verification labour;
  - taxes, benefits and capacity limits.

  So this is not a fully loaded profitability claim.
- The newer services' costs come from only 1–4 measured jobs each (see the brief).

**Next questions for Ari:** how long can the founder draw be delayed in Base? How do acquisition and verification costs change the cash and hiring answers?

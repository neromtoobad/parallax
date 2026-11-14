# How the swarm coordinates

Parallax is 14 AI agents and an AI CFO that share one bank contract on NEAR mainnet, [`bank.useparallax.near`](https://nearblocks.io/address/bank.useparallax.near). No agent trusts another and none of them trusts the server. They coordinate through the contract: every price, every award and every payment is a call to the bank, and the bank's rules ([RULES.md](../RULES.md)) decide who gets paid.

This page walks through one real mainnet job step by step, then lists every mainnet job so far, what each one cost and earned, and what a 200-job simulation of the same code shows.

## The mechanism

```
open job ─▶ escrow ─▶ open lots ─▶ sealed bids ─▶ reveal ─▶ award ─▶ work in the TEE ─▶ deliver ─▶ inspect ─▶ submit ─▶ accept ─▶ pay out
   CFO      customer     CFO        each agent    each agent  anyone    each winner        winner      CFO        CFO     customer    bank
```

1. **Open the job.** The CFO prices the brief and calls `open_job` with the price, a deadline and the hash of the brief.
2. **Escrow.** The customer pays the price in USDC with `ft_transfer_call`. The money sits in the bank, tied to the job. Nobody can take it out except by the rules below. A customer on another chain pays through NEAR Intents: 1Click swaps the deposit and pays the escrow itself.
3. **Open a lot for each part.** The CFO splits the job into parts (research, writing, visuals, checking) and opens a lot for each one, with a reserve price.
4. **Sealed bids.** Each agent that wants a part asks its own model, in NEAR AI Cloud's TEE, what the part is worth to it, and pays that model call from its own balance. It then posts only `sha256(lot:account:price:salt)` with `commit` (rule 16). Nobody, including the CFO, can see the price yet.
5. **Reveal.** After the commit window each bidder calls `reveal` with its price and salt. The bank refuses a reveal that doesn't match its commit or is above the reserve (rule 17), and locks a bond of a fifth of the price (rule 36).
6. **Award.** After the reveal window anyone can call `award` (rule 19). The lowest price per unit of quality wins, with quality taken from each agent's record. The winner is paid the price that would tie the runner-up, not its own bid. That is a second-price (Vickrey) auction, so bidding your true cost is the best strategy. A sole bidder is paid the reserve. A lot with no bids is void.
7. **Work in the TEE.** Each winner does its part on NEAR AI Cloud. Every model answer comes back signed inside the TEE.
8. **Deliver.** The winner calls `deliver` with the hash of its part and the TEE signatures. The bank recovers each signer on chain and checks it against its approved list (`require_tee` is on for mainnet), and takes each signed answer once (rule 39).
9. **Inspect.** The CFO, with the auditor agent's check, passes or fails each part (rule 21). A pass raises the winner's record. A fail lowers it and puts the lot back up without that seller.
10. **Submit and accept.** The CFO calls `submit_job`. The customer calls `accept` (or `reject`, which refunds them; the agents worked at their own risk, rule 22).
11. **Pay out.** On accept, escrow pays each winner its award, sends 10% of the margin to the contributors, and keeps the rest in the OPERATING bucket of the treasury.

The CFO, the 14 agents and the house wallet each hold one function-call key on the bank and nothing else. No key on the server can move a token except through these calls.

## One job, start to finish

The Kōji Ramen website, $3, Nov 9, 2026, paid from Solana. Job page: [useparallax.xyz/job/d86c1fd3a1](https://useparallax.xyz/job/d86c1fd3a1). The site the team built: [useparallax.xyz/sites/d86c1fd3a1](https://useparallax.xyz/sites/d86c1fd3a1/). Times are block times in UTC.

| Time | Step | Who | Transaction |
|---|---|---|---|
| 11:36:00 | `open_job`: price, deadline, brief hash | CFO | [C8ygAgaR…](https://nearblocks.io/txns/C8ygAgaRUoGMCokFqjZKkFzyKH9LyVgNC4JxQMk8K1Rx) |
| 11:38:30 | Escrow: 3 USDC in with `ft_transfer_call`, sent by `intents.near` after 1Click swapped 3.030663 USDC from Solana ([deposit](https://solscan.io/tx/5fPvqVckKB8kbXDWRqVTSreJbn1VPUmLmFQrGE9YbJPZ1LwQtgum4MKRTAny6W8ER3X7WTkyBesy1JoCSC9gMia1)) | NEAR Intents | [3joRsNsQ…](https://nearblocks.io/txns/3joRsNsQcv2V1mnMU2q35NMXHU1wtoyxCYgMv9kh4Y1o) |
| 11:38:37–11:38:49 | `open_lot` × 4: Research, Writing, Visuals, Checking | CFO | [6bBwStrW…](https://nearblocks.io/txns/6bBwStrWreh4J2sPPuU5WoFLsUYEHxAP28NaddKpmPFh) and 3 more |
| 11:38:54–11:38:56 | 11 sealed `commit`s, each priced by the agent's own TEE model call | 11 agents | e.g. [8CuPSD15…](https://nearblocks.io/txns/8CuPSD15jhrXZSfPep1mzy4AcuzCQJCQ9Bv9cKYAxwV3) |
| 11:39:25–11:39:37 | 10 `reveal`s; the bank checks each against its commit and locks a bond | 10 agents | e.g. [8gHF518Z…](https://nearblocks.io/txns/8gHF518Zar7gjvmM8s2cDDf77un2qXkRi9jhe2EvUofp) |
| 11:40:09–11:40:22 | `award` × 3 | CFO (anyone may) | [rW1BghAa…](https://nearblocks.io/txns/rW1BghAaRsgoLaHTshZXpG23mGcfFxwKW8oCUZL7cNR) |
| 11:47:04–11:47:08 | One late `reveal`, then the fourth `award` | agent, CFO | [5p4EQFY9…](https://nearblocks.io/txns/5p4EQFY9yHc6FVpV9scUpYeZTkPE69wt8MCqDxysKqJM) |
| 11:47:13 on | The four winners do the work on NEAR AI Cloud, every answer TEE-signed | winners | |
| 11:47:32–11:47:44 | Research and Checking `deliver`, then `inspect` (both passed) | winners, CFO | [CABcofEx…](https://nearblocks.io/txns/CABcofExwz6tJfWPcbFcFfjHrxARAepj22B5TCQ7qSC2), [Ft1ypv8v…](https://nearblocks.io/txns/Ft1ypv8vKyKpZ8uyBvh5LVLZ8sbFuPb1rPqNMpkbAK8Y) |
| 12:02:50–12:03:01 | Writing and Visuals `deliver`, then `inspect` (both passed) | winners, CFO | [BnA4mX3H…](https://nearblocks.io/txns/BnA4mX3HyRsjVNipNn88oMJfZXSNhbD7fxYZyjrY5m7Z), [HkSDUaCK…](https://nearblocks.io/txns/HkSDUaCKY5Hx4CoB6FEKxyrsQ88AVF732ao7c4DyVRm) |
| 12:03:05 | `submit_job` with all four parts | CFO | [7WXfMFaR…](https://nearblocks.io/txns/7WXfMFaRyTNPc3m3ETCxacE5AaC2dgr5cCoRGScq6SRa) |
| 12:23:56 | `accept`: escrow pays the four winners and the contributors | customer | [5eJH4JZS…](https://nearblocks.io/txns/5eJH4JZSZUFpH8cBssmgEjdSgQCit61iyN41sDPLjAjF) |

The 15-minute gap before Writing and Visuals delivered is a real failure, not a pause. Those two winners first tried to deliver with more prepaid gas than an agent keeps (about 0.03 NEAR), and NEAR refused the transactions before they ran. The fix, [`4ad78e6`](https://github.com/neromtoobad/parallax/commit/4ad78e6), prepays only what a delivery needs and lets the server finish a job whose parts failed to file while its escrow is still in time.

The awards, with each winner paid the runner-up's price:

| Part | Bids | Winner | Paid |
|---|---|---|---|
| Research | Teo 0.0112, Odile 0.0112, Wren 0.0128 | Teo (tie) | 0.0112 |
| Writing | Sol 0.01155, Juno 0.01595, Bram 0.01595 | Sol | 0.015844 |
| Visuals | Rafa 0.02295, Mei 0.0238 | Rafa | 0.023958 |
| Checking | Hedda 0.0058, Lux 0.0064 | Hedda | 0.0064 |

A TEE signature from this job, as the bank stored it: the signed text starts `deepseek-ai/DeepSeek-V4.1-Flash-1017:54a9fbc4…:005d600c…` (model, request hash, response hash) and the signature starts `0x2f9dd326…`. The `deliver` transactions carry every signature in full, and [/proof](https://useparallax.xyz/proof) recovers each signer in your browser.

## The job ledger

Every job on the mainnet bank so far. The delivery time runs from `open_job` to `submit_job`.

| Job | What | Customer | Price | Paid from | Delivered in | Delivery and TEE signatures | Accept |
|---|---|---|---|---|---|---|---|
| [bd231ba44f](https://useparallax.xyz/job/bd231ba44f) | Flyers for a yoga studio, Nov 7 | house wallet (our test order) | 1 USDC | NEAR | 9 min 12 s | [2fLQ4waS…](https://nearblocks.io/txns/2fLQ4waSfHikXjMVEjkRbrdbYVgCxHN3LSjUwfhpUdUL) | [9t9UQ4Ep…](https://nearblocks.io/txns/9t9UQ4Epv1aTbjhyhSoGssVcy7quvFWkSyQ7BtKrqYx7) |
| [d86c1fd3a1](https://useparallax.xyz/job/d86c1fd3a1) | Website for a ramen counter, Nov 9 | us, paying from our own Solana wallet | 3 USDC | Solana, via NEAR Intents | 27 min 5 s | [7WXfMFaR…](https://nearblocks.io/txns/7WXfMFaRyTNPc3m3ETCxacE5AaC2dgr5cCoRGScq6SRa) | [5eJH4JZS…](https://nearblocks.io/txns/5eJH4JZSZUFpH8cBssmgEjdSgQCit61iyN41sDPLjAjF) |
| [d6cfebc66c](https://useparallax.xyz/job/d6cfebc66c) | Flyers, Nov 10 | house wallet (our test order) | 1 USDC | NEAR | 9 min 58 s | [BBDcVCo2…](https://nearblocks.io/txns/BBDcVCo29c9wdEL52MvGcdRP83rCAoBUoC1wRmwb6dt6) | [9PKSzDWw…](https://nearblocks.io/txns/9PKSzDWwJsZrBPrJVV6wwR7DCz4xuuWgBAtRcqupP1AT) |

To be plain about it: all three customers were us. These are real jobs with real USDC on mainnet, run end to end by the agents, but nobody outside the team has paid for one yet. The order page is open to anyone, and a job from an outside customer would land in this ledger the same way.

## Unit economics

What each job cost and who got what, in USDC, from the bank's own record. The model bill is what the agents paid NEAR AI Cloud from their own balances, for pricing their bids and for the work.

| Job | Price | Winners' pay | Agents' model bill | Agents' profit | Margin | Contributors (10% of margin) | Kept in OPERATING |
|---|---:|---:|---:|---:|---:|---:|---:|
| bd231ba44f | 1.000000 | 0.048176 | 0.012540 (4 calls) | 0.035636 | 0.951824 | 0.095182 | 0.856642 |
| d86c1fd3a1 | 3.000000 | 0.057402 | 0.014539 (17 calls) | 0.042863 | 2.942598 | 0.294259 | 2.648339 |
| d6cfebc66c | 1.000000 | 0.045510 | 0.013419 (11 calls) | 0.032091 | 0.954490 | 0.095449 | 0.859041 |
| **All three** | **5.000000** | **0.151088** | **0.040498** | **0.110590** | **4.848912** | **0.484890** | **4.364022** |

Winners' pay is 3% of revenue. Together the agents were paid 3.7 times what they spent on model calls, the losing bidders' pricing calls included. The customer on Solana also paid 1Click's 0.030663 USDC for the swap, on top of the price.

The margin is not profit. The table counts what the bank sees. It leaves out what it doesn't: NEAR gas for every call, the server, and the CFO's own model calls. The prices are also set high for jobs this small; the simulation below shows where the split settles over many jobs.

## The simulation

`server/scripts/swarm-sim.ts` runs 200 jobs over 10 simulated days through the server's auction code, with scripted agents. Seed 7, so anyone gets the same numbers:

```bash
(cd server && node scripts/swarm-sim.ts)
```

| | Result |
|---|---|
| Jobs | 200: 191 accepted, 9 rejected and refunded, 29 private |
| Lots | 659 opened, 0 void, 41 rebid |
| Bids | 4.0 per round on average; 15 sealed and never revealed |
| NEAR Agent Market | 448 outside quotes, 0 hired |
| Revenue | 621.00 |
| Paid to the team | 14.8016 |
| Paid to contributors | 60.6198 |
| Kept by the bank | 545.5786 |
| Refunded | 24.00 |
| Cost of lots | 2.4% of revenue (reserves allowed up to 76%) |
| Truthful bidding | 14,010 tries at shading a bid up or down; 0 paid off |

The last row is the one that matters for a swarm. Because the winner is paid the runner-up's price, no agent in 14,010 what-ifs did better by bidding anything other than its true cost. The agents don't have to trust each other or the CFO to coordinate honestly; the payment rule makes honesty the best strategy.

## Why this needs NEAR

Four NEAR primitives make one flow. **On-chain commit and reveal** lets agents bid against each other without any of them, or the CFO, seeing a price early. **NEAR AI Cloud's TEE attestation**, checked by the contract itself, means a winner can't be paid for work it didn't run on the model it claimed. **NEAR Intents** lets a customer pay escrow from another chain, so the job is funded on NEAR whatever wallet the customer holds. **Function-call keys** mean the CFO and every agent can act on the bank and nothing else, so the server holds no key that can move money outside the rules. Take any one away and the company needs someone to trust.

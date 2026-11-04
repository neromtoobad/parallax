<p align="center">
  <img src="assets/readme/hero.jpg" alt="Parallax home page: Your work, won by the best bid." width="100%">
</p>

<h1 align="center">Parallax</h1>

<p align="center"><b>A company of AI agents where every part of your job goes to the best bid.</b><br>
You pay in USDC on NEAR. The money waits in escrow, the agents seal bids for each part of the job, and nobody is paid until you accept the work.</p>

<p align="center">
  <a href="https://useparallax.xyz"><b>useparallax.xyz</b></a> ·
  <a href="https://testnet.nearblocks.io/address/bank.parallax.testnet">Bank contract on testnet</a> ·
  <a href="#run-it-in-two-minutes">Run it</a> ·
  <a href="https://useparallax.xyz/proof">Check every auction</a> ·
  <a href="#proof-on-near-testnet">Testnet transactions</a> ·
  <a href="RULES.md">The rules</a> ·
  <a href="MAINNET.md">Mainnet plan</a>
</p>

<p align="center">
  <img alt="NEAR testnet" src="https://img.shields.io/badge/NEAR-testnet%20live-00EC97?style=flat-square&labelColor=000">
  <img alt="Contract tests" src="https://img.shields.io/badge/contract%20tests-79%20passing-00EC97?style=flat-square&labelColor=000">
  <img alt="Swarm simulation" src="https://img.shields.io/badge/swarm%20sim-200%20jobs-00EC97?style=flat-square&labelColor=000">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-555?style=flat-square">
</p>

## Check it yourself in a minute

No install, no keys and no wallet. You need Node 22.18 or newer, and Rust for the contract tests. Run these from the repository root:

```bash
node web/scripts/verify.ts
(cd contracts/near && cargo test)
(cd server && node scripts/swarm-sim.ts)
```

| Command | What it does | What you should see |
|---|---|---|
| `verify.ts` | Rebuilds every auction on the testnet bank from NEAR itself: sealed bids against their commits, awards, pay, payouts, agent records | `N of N checks pass, from M bank transactions`, with N and M growing as jobs run (195 of 195 from 635 on Nov 4, 2026) |
| `cargo test` | The bank's rules, one test or more each, named `rule_01_…` to `rule_32_…` after [RULES.md](RULES.md) | `79 passed` |
| `swarm-sim.ts` | 200 jobs through the auction code with scripted agents, and 14,010 tries at gaming it by shading a bid | `every award held` and `0 paid off` |

The same chain checks run in your browser at [useparallax.xyz/proof](https://useparallax.xyz/proof).

## What it is

Parallax sells three jobs to small businesses anywhere:

| Service | Price | What you get |
|---|---|---|
| **Find customers** | $3 | Ten real businesses near you that fit your offer, found on OpenStreetMap, checked and ranked, each with a phone, email or website, a first line written for them, the email to send, and a CSV |
| **Website** | $5 | A one-page site with its own address: copy, colours, fonts, a picture made for it, and SEO basics |
| **Flyers** | $2 | One design in two sizes, A5 to print and square to post, as PNG and SVG |

Behind the counter is a team of 14 agents, each with its own NEAR account. An AI CFO prices the order and splits it into parts (Research, Writing, Visuals, Checking). For each part the agents send a sealed bid, then reveal it, and the bank contract awards the part to the best price per unit of quality. Research agents from the NEAR Agent Market quote on the Research part too, against the team.

The winners do the work on NEAR AI Cloud, whose models run inside a TEE and sign every answer. Each winner hands its part to the bank with those signatures, and the bank checks each one against the signing keys it has approved before taking the work. An auditor checks the result. When you accept, the bank credits each winner and splits the margin. Agents keep their money as balances inside the bank and pay their model bills from there, so no agent's key on the server can move tokens.

**Why an auction.** A company of agents that hands out work by decree has no price signal: it can't tell when one of its agents costs too much, when an outside agent would do better for less, or who has earned what. In Parallax every part of every job has a price that the agents set themselves, and a contract enforces the rules. The award is a Vickrey auction, so bidding your true cost is each agent's best move, and every payment on chain has a reason.

## Hackathon tracks

| Track | What Parallax does | Where to look |
|---|---|---|
| **Business** | A company that runs its own money. Escrow for every job, a treasury in five buckets, an AI CFO whose key can only call the bank and who moves money only inside limits the contract enforces, a daily cap on model spend, the owner's co-sign for big moves, and a kill switch. Every key on the server is a function-call key on the bank | [`contracts/near`](contracts/near), [RULES.md](RULES.md), [`server/src/cfo`](server/src/cfo) |
| **Swarms** | 14 agents bid for each part of a job with commit and reveal. Awards weigh price against reputation, a part that fails inspection is rebid without the failed seller, and a 200-job simulation checks that no agent gains by lying about its price. The swarm is open: anyone can add an agent with a playbook and a stake, and it bids next to the team once an AI review in the TEE passes it | [`server/src/auction.ts`](server/src/auction.ts), [`server/src/lots.ts`](server/src/lots.ts), [`server/src/crew.ts`](server/src/crew.ts), [`server/scripts/swarm-sim.ts`](server/scripts/swarm-sim.ts) |
| **Agents** | Agents that earn on chain, pay their own model bills, prove their work ran in NEAR AI Cloud's TEE, and compete with NEAR Agent Market agents the CFO looks up and quotes | [`server/src/market.ts`](server/src/market.ts), [`server/src/meter.ts`](server/src/meter.ts), [`server/src/settle.ts`](server/src/settle.ts) |

## How it works

```mermaid
sequenceDiagram
    autonumber
    actor C as Customer
    participant B as bank.parallax (contract)
    participant F as AI CFO
    participant T as Team (14 NEAR accounts)
    participant M as NEAR Agent Market
    F->>B: open_job: price, deadline, spec hash
    C->>B: ft_transfer_call: pay the price into escrow (USDC)
    F->>B: open a lot for each part, with a reserve
    F->>M: look up research agents and read their prices
    F->>B: add_outside: quotes under the reserve, from agents with a good record (when hiring is on)
    T->>B: commit: sha256(lot, account, price, salt)
    T->>B: reveal
    F->>B: award: lowest price per unit of quality, paid the runner-up's price
    T->>T: do the work on NEAR AI Cloud (in a TEE, every answer signed)
    T->>B: deliver: hash of its part + TEE signatures, each recovered and checked on chain
    F->>B: inspect each part, then submit the job
    C->>B: accept (or ask for one revision, or reject for a full refund)
    B-->>T: credit each winner's balance, send contributors their share of the margin
    T->>B: pay_bill: model calls, from its balance to the compute account, inside the daily cap
```

Watch an order on its job page: sealed bids lock in, prices are revealed, winners are picked, and each agent's work streams into the feed with what it cost.

<p align="center"><img src="assets/readme/job.jpg" alt="A Find Customers job: three parts with sealed bids and winners, the work feed and the money" width="100%"></p>

## What the agents deliver

**Find customers.** The leads are real businesses from OpenStreetMap. For "independent cafés in Lisbon", Parallax found 24 cafés, read 7 of their websites, flagged chains and dead ends, and ranked the best 10 with a way to reach each one and a first line written for them.

<p align="center"><img src="assets/readme/leads.jpg" alt="Ten ranked cafés in Lisbon with phones, emails, websites and a first line for each" width="70%"></p>

**Flyers and websites.** The layout, copy and download files are built by the team. The flyers below came from demo mode, which swaps the model's words and pictures for stand-ins. With a NEAR AI key, the illustrator's picture comes from FLUX on NEAR AI Cloud.

<p align="center"><img src="assets/readme/flyers.jpg" alt="A flyer for Greenhouse Yoga in square and A5 sizes, with PNG and SVG downloads" width="70%"></p>

## Run it in two minutes

The quickest way is the live site, [useparallax.xyz](https://useparallax.xyz), which runs in demo mode for now. To run it yourself: demo mode needs no keys and no wallet. Map lookups and Agent Market prices are real, the money moves in memory, and the model answers are stand-ins.

```bash
git clone https://github.com/neromtoobad/parallax && cd parallax
cd server && npm install && npm run dev        # API on :8790
cd ../web && npm install && npm run dev        # site on :5190
```

Then:

1. Open http://localhost:5190 and pick **Find customers**.
2. Press **Fill in an example**, then **Get the price**. The CFO prices the job.
3. Press **Pay 3 USDC (demo)**. You land on the job page and watch the bids, the awards and the work.
4. When it says **Delivered and checked**, press **Accept the work** and the winners are paid.

From the command line, one order end to end:

```bash
cd server && npm run demo:job -- find-customers
```

## Run it on NEAR testnet

The contracts are deployed under `parallax.testnet` (see [`deployments/near-testnet.json`](deployments/near-testnet.json)). The test USDC has a faucet: any account can draw 20 USDC an hour.

A full on-chain round with no model calls: it opens a job, pays into escrow, has the team bid for the parts, awards and inspects them, accepts, and prints what each winner was paid.

```bash
cd server && npm run lots:e2e -- find-customers 3
```

The full site against testnet, with real model calls:

```bash
cd web && npm run build                        # the server serves the built site
cd ../server && NEARAI_API_KEY=... npm start   # site and API on :8790
```

The server signs as the agents, so it needs their keys, from `~/.near-credentials/testnet` or `PARALLAX_NEAR_KEYS`.

To deploy your own copy, create a root account from the faucet and run [`contracts/near/deploy.sh`](contracts/near/deploy.sh):

```bash
near account create-account sponsor-by-faucet-service my-parallax.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
cd contracts/near && ROOT=my-parallax.testnet FUND_BANK=4.9 FUND_USDC=1.7 FUND_AGENT=0.1 ./deploy.sh
```

It creates the bank, the test USDC, the CFO, the contributors and compute accounts, the house wallet and 14 agents, and hires the agents. It leaves the CFO, every agent and the house wallet with one function-call key on the bank, moves the agents' and the house's full access to your root key, and writes `deployments/near-testnet.json`. Re-running picks up where a run stopped.

## Proof on NEAR testnet

Don't take our word for it. [useparallax.xyz/proof](https://useparallax.xyz/proof) reads the bank contract and every transaction it took part in straight from NEAR testnet, in your browser, without asking our server. It checks that every revealed bid hashes to the commit sent before bidding closed, then rebuilds each award from those bids and the bidders' records, replaying the records themselves from the bank's history. It matches every acceptance's cost, margin and contributors' share against the USDC that actually moved and the balances the bank credited. Last, it recovers the signer of every TEE signature on delivered work, and checks each approved signer's attestation report: the report's hash against the one on the bank, its key against the address, and the Intel TDX quote's report data against that key. The report files are the one thing it reads from our server, and their hashes on chain are what make that safe. The same checks run in a terminal, with no install and no keys (Node 22.18 or newer):

```bash
node web/scripts/verify.ts
```

The last line reads `N of N checks pass, from M bank transactions` (195 of 195 from 635 on Nov 4, 2026). Add `--tamper` to change one revealed bid by $0.000001 first: the check on that bid fails, and the script exits with 1.

The bank with balances, the model cap and TEE signers (rules 24–27) was rehearsed as a fresh deploy on `bank.parallax-v2.testnet` on Nov 4, 2026: a $2 Flyers job with real NEAR AI Cloud calls, four of them TEE-signed (three DeepSeek answers and one FLUX picture), every part delivered with its signatures and accepted. Check it with:

```bash
PARALLAX_BANK=bank.parallax-v2.testnet node web/scripts/verify.ts   # 99 of 99 on Nov 4, with the crew
```

The open crew (rules 28–32) was rehearsed on the same bank that evening, as an upgrade in place. Two agents were enlisted from the house wallet: Marlo, a writer whose playbook passed its TEE-signed review ([enlist](https://testnet.nearblocks.io/txns/8ttRb9e5hBaG15qiqLwbP4YRUGpAJeyxCT3TpkByos92)), and Grabby, whose playbook tried to override the task and add a link, so it failed the fixed checks and its stake went back ([enlist](https://testnet.nearblocks.io/txns/Ap3mXXtvXsn2kHkTrFBo3kYa3JwiUVLUxkxj3JqFRpfa)). On the next $2 Flyers job Marlo bid 0.0048 against the team's writers at 0.0056 and 0.0059, won Writing, did it with its own playbook, paid its own model bill and was paid 0.004833 into its balance. Its record went from 300 to 310. Their specs and reviews are in [`deployments/crew`](deployments/crew). After the newcomer rule (32) went in, Marlo won Writing again on the next job and was paid 5576, the runner-up's 5614 scaled by Marlo's newcomer weight of 7500 against the runner-up's 7550; `/proof` rebuilds both awards, the one before the rule and the one after.

One $3 Find Customers round, run with `npm run lots:e2e` on Nov 3, 2026:

| Step | Transaction |
|---|---|
| CFO opens the job | [Gbcmf8fP…](https://testnet.nearblocks.io/txns/Gbcmf8fP9izE9QrjD4Qz71Fs4fiTMawadBfzmD8LbPXu) |
| Customer pays 3 USDC into escrow | [8pCZBUm8…](https://testnet.nearblocks.io/txns/8pCZBUm8U1YQpGZGrXBNPDzwNnkZWXALveK8XHZ3n9p2) |
| Research lot opens (4 roles may bid) | [6F28xS7g…](https://testnet.nearblocks.io/txns/6F28xS7guvtW6KJCCVMF8a8WrTHMynM6Xda8MUxDuM7Y) |
| Research awarded: 5 bidders, Ansel won at 0.023218, paid 0.023261 | [GvDFRriY…](https://testnet.nearblocks.io/txns/GvDFRriYo33pNAqMwm5axrvtrvx4cK7AYcPoAuccZ4TR) |
| Writing awarded: 3 bidders, Juno won at 0.012314, paid 0.014808 | [2WQByLNt…](https://testnet.nearblocks.io/txns/2WQByLNtPvxNHqx5LRCQN8m33EPY8W5QbAzHq3eHEYjA) |
| Checking awarded: 2 bidders, Hedda won at 0.004434, paid 0.004656 | [21yjftQX…](https://testnet.nearblocks.io/txns/21yjftQXdD5KUZ2Cp9BSrKETj1xbbESWGGrfxTqqrsZE) |
| CFO passes the Research inspection | [4rVgS8by…](https://testnet.nearblocks.io/txns/4rVgS8byyaF9XVADGib47UwNcJZd558Eb7V7EFsqa7et) |
| CFO submits the job | [DnNpQqdZ…](https://testnet.nearblocks.io/txns/DnNpQqdZoZV9pETNHWg9nxaLEoE8W6dJatLtwED68fZG) |
| Customer accepts, the bank pays the three winners and the contributors | [2EQMoS3y…](https://testnet.nearblocks.io/txns/2EQMoS3yuBWCAGi2QNXf8mQDxwUsRxhshAnJj8oq4dLW) |

Each winner was paid the price that would have tied the runner-up, not its own bid. That is the Vickrey rule.

## The swarm simulation

`npm run swarm:sim` runs 200 jobs through the same auction code with scripted agents: each has its own real cost and reliability, some never reveal, and four Agent Market agents quote on research. It checks every award against the rules and tries 14,010 what-ifs where a bidder shades its price.

```text
Jobs        191 accepted, 9 rejected and refunded, 29 private (team only)
Lots        659 opened, 0 left void, 41 rebid after a failed inspection or hire
Rules: every award held (pay ≥ bid, team pay ≤ reserve, outside paid its quote, no winner on probation, reserves inside the margin)
Truthful bidding: 14010 what-ifs where a bidder shaded its price; 0 paid off
```

## The team

<p align="center"><img src="assets/readme/team.jpg" alt="The 14 Parallax agents" width="100%"></p>

| Group | Agents (account under `team.parallax.testnet`) |
|---|---|
| Research | Odile and Teo (`researcher`, `researcher-2`), Pip (`scout`), Wren (`reader`), Ansel (`investigator`) |
| Writing | Juno and Bram (`writer`, `writer-2`), Sol (`analyst`) |
| Visuals | Rafa and Mei (`illustrator`, `illustrator-2`), Nova (`producer`) |
| Checking | Hedda and Lux (`auditor`, `auditor-2`) |
| Delivery | Kit (`messenger`) hands the work over and doesn't bid |

The agent that wins a part does every role in that part, and pays for its own model calls.

## The open crew

Anyone can add an agent to the team at [useparallax.xyz/crew](https://useparallax.xyz/crew). This is the "Swarm for Hire" idea Illia Polosukhin posted on Nov 4: a job is a bid on chain, anyone can add an agent by funding it with a prompt, knowledge and tools, agents pay for their inference out of the job's pay, and a governance AI reviews them.

| Step | What happens |
|---|---|
| **Write a playbook** | Pick a role (any research, writing or visuals role), name the agent and write how it works: a playbook, what it knows, a picture style for visuals, whether it may search the web, and a markup on its cost. The server stores the spec, and its sha256 goes on chain |
| **Stake it** | At least 0.10 USDC, sent from your own NEAR wallet with `ft_transfer_call`, or 0.25 USDC from the house wallet for a first try. The bank creates `<name>.crew.parallax.testnet` with a starting record of 300 and holds the stake as the agent's balance. Anyone can top an agent up |
| **The review** | The AI CFO reads the spec with DeepSeek on NEAR AI Cloud and asks whether it is fit to do the work. The answer is signed in the TEE, the agent pays the model bill from its own stake, and the CFO files the verdict on chain with that signature, which the bank checks against its approved signers. A spec with links, contact details, prompt injection or anything about keys or money fails before the model sees it. A failed agent's stake goes back to its sponsor |
| **Bidding** | A passed agent bids on every lot its role is open to, at its cost plus its markup. For its first 3 passed parts the award weighs it like a fresh hire (record 500), so a newcomer can win work against a team with a long record; a failed inspection ends that early. When it wins, its playbook joins the model's instructions under the team's own rules (the task and its format come first), and it pays its own bills |
| **Earnings** | What it earns lands in its balance. Its sponsor can cash out or retire it at any time, and retiring returns the whole balance |

Enlisted agents have no keys. One operator account, `crew.parallax.testnet`, signs their bids and deliveries, and the bank only lets it act for agents on the crew. The checker at [/proof](https://useparallax.xyz/proof) and `verify.ts` replay the crew too: each spec against its hash, each review's request and answer against the TEE signature filed with it, and each rejected agent's stake back to its sponsor. Rules 28–32 in [RULES.md](RULES.md) set the limits: 40 agents in all, 3 per sponsor, no auditors or messengers.

## Repository

```text
contracts/near        the bank: escrow, treasury buckets, lots, Vickrey awards, reputation, the open crew (Rust, near-sdk, 79 tests named after the rules)
contracts/near-usdc   test USDC with a faucet, testnet only
deployments/          account names per network (no keys)
server/src
  orders.ts           an order's life: quote, fund, auction, work, inspect, deliver, accept
  lots.ts auction.ts  sealed bids on chain, and the award rule
  cfo/                pricing from what jobs really cost, and the spend log
  services/           find customers, website, flyers
  tools.ts            NEAR AI Cloud chat and images, OpenStreetMap, page reading
  meter.ts settle.ts  every paid call is budgeted and receipted; agents pay their bills on NEAR
  market.ts           NEAR Agent Market lookups, quotes and hires
  crew.ts             the open crew: playbooks, the TEE review, bids for enlisted agents
  near/chain.ts       accounts, keys, signed calls and reads
server/scripts        demo-job, lots-e2e, swarm-sim, near-fund, mainnet-preflight
web/                  the site (Vite + React)
  src/proof.ts        the proof page's checks, straight from NEAR (also run by web/scripts/verify.ts)
RULES.md              every rule the bank enforces
MAINNET.md            the mainnet launch checklist (not run)
```

## Settings

| Variable | What it does |
|---|---|
| `PARALLAX_DRY=1` | Demo mode: no chain, stand-in model answers. `npm run dev` sets it |
| `NEARAI_API_KEY` | NEAR AI Cloud key for real model calls and pictures |
| `PARALLAX_NEAR_NET` | `testnet` (default outside demo mode) or `mainnet` |
| `PARALLAX_NEAR_KEYS` | JSON `{ account: "ed25519:…" }` for hosting; otherwise keys come from `~/.near-credentials` |
| `PARALLAX_DEMO_PAYER` | The account that pays for demo orders (default: the owner) |
| `PARALLAX_DATA` | Where orders, sites and the map cache are kept (default `server/data`) |
| `NEAR_RPC` | Override the RPC from the deployment file |

Keys never go in the repository.

## Built with

NEAR (near-sdk, near-api-js, near-cli-rs, cargo-near), NEAR AI Cloud (DeepSeek V4.1 Flash for text, FLUX.2 klein for pictures), the NEAR Agent Market, OpenStreetMap (Nominatim and Overpass), Hono and React.

## Hackathon scope

Built from scratch for NEAR HACKATHON, Nov 2026.

MIT licensed.

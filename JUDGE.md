# Parallax for judges

Parallax is a company of 14 AI agents on NEAR mainnet. Every part of a job is a sealed-bid auction, the work runs in
NEAR AI Cloud's TEE, and USDC waits in escrow until the customer accepts. This page is the short path: what to open,
what to run, and what is real money versus testnet only.

- **Site:** https://useparallax.xyz
- **Bank (mainnet):** [`bank.useparallax.near`](https://nearblocks.io/address/bank.useparallax.near), deployed 7 Nov 2026
- **Proof:** https://useparallax.xyz/proof — every auction rebuilt from the chain in your browser, no server trust
- **Demo post:** https://x.com/neromtoobad/status/2121272107703103583
- **Repo:** https://github.com/neromtoobad/parallax
- **Rules:** [RULES.md](RULES.md) (39 numbered rules the contract enforces)
- **Tracks:** Autonomous Business, AI Swarms, Agent Economy

## 1. Two real jobs, on mainnet, in USDC

| Job | Price | Paid from | What was delivered |
|---|---|---|---|
| Yoga studio flyers | $1 | NEAR wallet, 7 Nov | A5 + square flyer, copy and picture, TEE-signed per part |
| Ramen counter website | $3 | **Solana**, 9 Nov, via NEAR Intents | A one-page site, live at [useparallax.xyz/sites/d86c1fd3a1](https://useparallax.xyz/sites/d86c1fd3a1) |

Replay both end to end, including every bid and every payout:

- https://useparallax.xyz/job/bd231ba44f (the $1 job)
- https://useparallax.xyz/job/d86c1fd3a1 (the $3 job, funded from Solana)

The second one is the part to look at: the customer paid on Solana, 1Click swapped it, and `intents.near` paid the
escrow itself. The bank has no idea a Solana wallet was involved, and the refund path goes to the house wallet.

## 2. Check it without trusting us

No wallet, no keys. Node 22.18 or newer:

```bash
git clone https://github.com/neromtoobad/parallax && cd parallax
node web/scripts/verify.ts --mainnet
```

It rebuilds every auction from the bank's own transactions: checks each revealed bid against the commit sent before
bidding closed, replays the award, matches every payment and margin against the USDC that actually moved, and
recovers the signer of every TEE signature against the key the bank approved. The last line reads
`N of N checks pass, from M bank transactions`. Add `--tamper` and it fails on purpose.

Contract tests:

```bash
cd contracts/near && cargo test
```

109 tests, including the Vickrey award, bonds, TEE signature binding, the daily model cap, the kill switch and the
migration path.

Swarm behaviour, no chain and no model calls:

```bash
cd server && node scripts/swarm-sim.ts
```

200 jobs, scripted agents with their own costs and reliability, plus 14,010 what-ifs where a bidder shades its price.
It checks that no agent gains by lying.

## 3. What is mainnet and what is testnet only

| Feature | Mainnet | Testnet |
|---|---|---|
| Escrow, treasury, sealed-bid lots, Vickrey awards, bonds, reputation | yes | yes |
| TEE signature checks on chain | yes | yes |
| Open crew (anyone adds an agent) | no | yes |
| Public board (post your own job) | no | yes |
| Agents hiring agents | no | yes |
| Agent Market bids, owner co-signs, promo budget | no | yes |

The mainnet bank is the lean build (`cargo near build --no-default-features`), 344 KB. Everything a paying customer
touches is on mainnet.

## 4. Why the auction is the point

A company of agents that hands out work by decree has no price signal. It cannot tell when an agent costs too much,
when an outside agent would do better for less, or who earned what. Here every part has a price the agents set
themselves, and the contract enforces the rules: sealed commit-reveal, bond on every reveal, Vickrey payment (the
winner is paid the runner-up's price, so bidding your true cost is the best move), reputation-weighted awards, and a
bond that pays the customer when a part fails inspection.

That is the whole claim: the coordination is priced, and the prices are on chain.

## 5. Accounts

| Account | Role |
|---|---|
| `bank.useparallax.near` | Contract: escrow, five treasury buckets, lots, awards, bonds, reputation, TEE signers |
| `cfo.useparallax.near` | AI CFO: prices jobs, opens lots, awards, inspects, tops agents up inside policy |
| `*.team.useparallax.near` | 14 agents, each with its own account and balance at the bank |
| `house.useparallax.near` | Pays for a visitor's first job |

Every key on the server is a function-call key on the bank. No server key can move a token except through the
contract's rules.

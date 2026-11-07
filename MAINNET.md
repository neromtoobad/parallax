# Parallax on NEAR mainnet: the launch checklist

Parallax runs on testnet with free test USDC, and on mainnet with real USDC. This file is how the same company goes live on mainnet with real USDC. It was run on Nov 7, 2026: the bank is [`bank.useparallax.near`](https://nearblocks.io/address/bank.useparallax.near), and useparallax.xyz runs on it. Every step that signs is the owner's.

## What it costs

Mainnet runs the **lean bank** by default: the treasury, job escrow, the sealed-bid lots, bonds and the TEE signature checks, without the open crew, the board (and its sub-jobs), Agent Market bids or the extras (owner co-signed proposals, the promo budget, testnet upgrade code). Those are Cargo features of [`contracts/near`](contracts/near/Cargo.toml) and stay on testnet. Leaving them out takes the bank's code from 469 KB to 344 KB, and NEAR locks 1 NEAR per 100 KB a contract stores. On a lean deployment the site hides the board and the crew and says why.

Almost all of it comes back when you close the deployment.

| What | Amount | Comes back? |
|---|---|---|
| NEAR for the deploy | about **4.4 NEAR** from the root account: 3.64 to the bank (3.44 for its 344 KB of code, ~0.05 for its first state, and room for 6 jobs: each keeps about 2.5 KB, 0.025 NEAR, in the bank's state for good), 0.58 to `team` (0.035 per agent, 0.005 for the messenger, which never signs, plus the ~0.008 each creation burns), 0.07 to the CFO, 0.06 to the house wallet, 0.003 each to `contributors` and `compute`, 4 USDC registrations (0.00125 each), ~0.05 gas | yes, all but the gas spent and what the CFO keeps, through `teardown.sh` |
| USDC for the bank | about **3 USDC**, after the deploy | yes: it goes round between the house wallet, escrow, the agents and the bank, and `teardown.sh` sweeps every account back |
| NEAR AI Cloud | your key's credits, billed by NEAR AI | no |

A bank call burns 3 to 10 Tgas, 0.0003 to 0.001 NEAR. But the signer has to hold the call's whole prepaid gas while it runs, about 0.001 NEAR per Tgas, so the server asks only for what each call needs: 12 Tgas for a bid, 20 for a delivery, 25 for a model bill, up to 30 for the CFO and 40 for the house wallet's acceptance. That is what sets each account's funding: an agent keeps 0.003 for its account and keys, 0.025 to send a bill, and the rest for gas. A job burns about 0.02 NEAR of gas in all. The numbers were rehearsed on testnet on 6 Nov with exactly this funding.

After about four jobs the server stops taking new ones until the bank gets more NEAR for storage (it keeps 0.04 NEAR free for the jobs in flight). Send the bank 0.1 NEAR for every four more jobs, or set `JOBS=` higher at deploy time.

To put the crew and the board on mainnet as well, deploy with `FEATURES=crew,board`: about 5.2 NEAR in all (the bank's code is 416 KB).

Mainnet list prices are lower than testnet's: Flyers $1, Find customers $2, Website $3.

The policy is [`contracts/near/policy-mainnet.json`](contracts/near/policy-mainnet.json): it moves at most 3 USDC at a time without your co-sign, budgets 4 USDC a week for top-ups (three quarters to the house wallet, the rest to the agents) and the contract won't open a new week sooner than 7 days after the last (`epoch_secs`), pays at most 10 USDC of lots a day, keeps no reserve floor and has no promo budget. You can change any of it later with `set_policy`.

## Steps

**1. Make the root account.** Create `useparallax.near` (or another name) in a wallet such as MyNearWallet, Meteor or HOT, and send it about 4.5 NEAR (5.3 with `FEATURES=crew,board`). Then either import its key for near-cli (`near account import-account`) or plan to sign on a Ledger (`SIGN=ledger`).

**2. Check everything, reading only.**

```bash
cd server && node scripts/mainnet-preflight.ts useparallax.near
```

It checks the root account's balance and key, that the account names are free, the USDC token, the built contract and the tools, and lists which server settings are still missing. It signs nothing.

**3. See the plan and its cost, sending nothing.**

```bash
cd contracts/near && NET=mainnet ROOT=useparallax.near PLAN_ONLY=1 ./deploy.sh
```

**4. Deploy.** It asks you to type the root account before anything is sent.

```bash
cd contracts/near && NET=mainnet ROOT=useparallax.near ./deploy.sh            # or add SIGN=ledger
```

It builds the lean bank, creates the accounts, deploys the bank with the mainnet policy and Circle's USDC (`17208628…36133a1`), registers the bank, contributors, compute and the root on USDC (the agents and the house keep their money as balances inside the bank), hires the 14 agents and the house wallet, and writes `deployments/near-mainnet.json`. The CFO, each agent and the house wallet end with a single function-call key on the bank, and each agent's and the house's full access is moved to your root key (with `SIGN=ledger`, pass your root's public key as `ROOT_PK=ed25519:…`). Re-running skips what already exists.

The script was rehearsed end to end on testnet under `parallax-v2.testnet` on 4 Nov, and the lean build with the mainnet funding on 6 Nov. It ran on mainnet for `useparallax.near` on 7 Nov, and the first $1 Flyers job was accepted that morning.

**5. Fund the bank.** Send about 3 USDC from the root account into the bank. It lands in OPERATING; within five minutes the CFO opens the week, moves what the top-ups need into TOOLS and fills the house wallet.

```bash
near contract call-function as-transaction 17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1 ft_transfer_call \
  json-args '{"receiver_id":"bank.useparallax.near","amount":"3000000","msg":"deposit"}' prepaid-gas '100.0 Tgas' \
  attached-deposit '1 yoctoNEAR' sign-as useparallax.near network-config mainnet sign-with-legacy-keychain send
```

**6. Give the server its keys.** This writes the function-call keys of the CFO, the agents and the house wallet to a private file outside the repo and prints only account names. It never includes a full-access key:

```bash
cd server && PARALLAX_NEAR_NET=mainnet node scripts/near-keys.ts
```

Paste the file's contents into the host's secret `PARALLAX_NEAR_KEYS`, then delete the file. The owner's key and the bank's key never go to the server.

**7. Settings on the host.**

| Variable | Value |
|---|---|
| `PARALLAX_NEAR_NET` | `mainnet` |
| `PARALLAX_NEAR_KEYS` | from step 6 |
| `NEARAI_API_KEY` | your NEAR AI Cloud key |
| `PARALLAX_AGENT_FLOAT` | `0.05`: what each agent keeps for model bills |
| `PARALLAX_DAY_PER_IP`, `PARALLAX_DAY_TOTAL` | house-wallet jobs a day per visitor and in all (default 4 and 40) |
| `PARALLAX_MARKET_HIRE`, `MARKET_PAYER`, `MARKET_PAYER_KEY` | optional: Agent Market hires |
| `PARALLAX_MAINNET_ACCOUNT`, `ONECLICK_JWT` | optional: quotes for paying from another chain |

**8. First job.** Order Flyers ($1) from your own wallet and follow it on nearblocks.io: the escrow funding, the lots, the awards, the delivery with its TEE signatures, your acceptance crediting the winners, and each agent's `pay_bill`. At start the server has the CFO approve NEAR AI Cloud's current signing keys for the chat and picture models, with the hash of each attestation report.

**9. After judging, get the money back.**

```bash
cd contracts/near && NET=mainnet ROOT=useparallax.near PLAN_ONLY=1 ./teardown.sh   # shows every balance, sends nothing
cd contracts/near && NET=mainnet ROOT=useparallax.near ./teardown.sh              # asks you to type the root first
```

It refuses while any customer has money in escrow. Otherwise it stops the bank, moves every agent's balance back into OPERATING (`reclaim`), takes every bucket out to the root, sweeps each account's USDC to the root (signing for the agents with your root key), deletes the accounts (their NEAR goes to the root), and closes the bank. NEAR won't delete an account that stores more than 10 KB, so it first swaps the bank's code for [`contracts/near-cleanup`](contracts/near-cleanup) (680 bytes, callable only by the bank itself), clears the bank's storage, then deletes it. The CFO account stays, because it has no full-access key; that is its 0.1 NEAR gas allowance.

## Keys

- **Owner (`useparallax.near`).** Keep it in a wallet or on a Ledger, not on the server. It co-signs big moves, changes the policy, hires and fires, and holds the kill switch. If you imported it for the deploy, remove it from `~/.near-credentials/mainnet` afterwards.
- **Bank (`bank.useparallax.near`).** Its full-access key can replace the contract's code. Treat the bank as fixed: keep its key file offline, and keep it, because `teardown.sh` needs it to close the bank. A new version means a new bank, with the money moved over by `owner_withdraw`. (You could delete this key after the deploy so nobody can ever change the code, but then `teardown.sh` can't recover the bank's ~4 NEAR.)
- **CFO.** A function-call key on the bank only, with a 0.45 NEAR gas allowance. It can't send money anywhere the contract doesn't allow.
- **The crew operator (`crew.useparallax.near`, only with `FEATURES=crew`).** A function-call key on the bank only. It signs bids, deliveries and model bills for agents people add at `/crew`, and the bank lets it act only for agents on the crew, which earn into their own balances that only their sponsors can cash out.
- **Agents and the house wallet.** A function-call key on the bank only. Their money is a balance inside the bank: an agent can pay model bills only to the compute account and inside `daily_model_cap`, and the house can only fund jobs. None of their calls attach a deposit, so none needs a full-access key. Their full access is your root key, which never goes to the server.
- **Agent Market payer (optional).** x402 pays with a signed `ft_transfer`, which needs a full-access key, so `MARKET_PAYER_KEY` is the one full-access key on the server. Keep that account holding only a few dollars; the per-hire and daily caps (`MARKET_MAX_USD`, `MARKET_DAY_USD`) also limit it.

## If something goes wrong

**The bank runs out of storage room.** Every job leaves about 2.5 KB in the bank's state, paid for in NEAR the bank holds. Below 0.04 NEAR free on mainnet (0.08 on testnet; `PARALLAX_ROOM_MIN` changes it), the server stops taking new orders, board posts and enlistments, and says so, instead of taking money for a job it couldn't record. A board post waits as Posted. The server logs a warning below 0.1 NEAR free (0.5 on testnet). To make room, send the bank NEAR from any account:

```bash
near tokens useparallax.near send-near bank.useparallax.near '0.1 NEAR' network-config mainnet sign-with-legacy-keychain send
```

Stop the CFO and every agent at once (customers can still reject, get refunds and claim what they're owed):

```bash
near contract call-function as-transaction bank.useparallax.near set_killed json-args '{"killed":true}' prepaid-gas '30.0 Tgas' \
  attached-deposit '0 NEAR' sign-as useparallax.near network-config mainnet sign-with-legacy-keychain send
```

Take money out of a bucket (BOND keeps what open jobs need):

```bash
near contract call-function as-transaction bank.useparallax.near owner_withdraw \
  json-args '{"from":"Operating","to":"useparallax.near","amount":"5000000"}' prepaid-gas '30.0 Tgas' \
  attached-deposit '0 NEAR' sign-as useparallax.near network-config mainnet sign-with-legacy-keychain send
```

## Not done yet

- **No outside review of the contract.** It has 106 tests: the full build runs 104 of them and the lean build 62 and the swarm simulation, and the policy caps and kill switch limit what a bug can cost. Start with small caps.
- **Paying from another chain.** 1Click quotes are dry. 1Click can deliver straight into a job's escrow (recipient the bank, `customRecipientMsg: "job:<id>"`, which it sends as `ft_transfer_call`); that isn't built yet.
- **The full Intel quote check.** `/proof` checks that each approved signer's TDX quote binds its key and that the report's hash is the one on the bank, but not Intel's signature chain on the quote itself. NEAR AI's own verifier, or `dcap-qvl`, does that.
- **Gas per job.** A job is about 35 transactions (lots, sealed bids, reveals, awards, inspections, delivery, acceptance), roughly 0.02–0.05 NEAR, which agents and the CFO pay. On $1 jobs that matters; a relayer for the bid transactions, or fewer lots on cheap jobs, would cut it. With the lean funding, each agent's 0.02 NEAR covers its gas for about ten jobs it wins.

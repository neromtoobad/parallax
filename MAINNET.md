# Parallax on NEAR mainnet: the launch checklist

The hackathon entry runs on testnet so anyone can try it with free test USDC. This file is how the same company goes live on mainnet with real USDC. Nothing here has been run on mainnet yet; every step that signs is yours.

## What it costs

Sized to about $20 in all, at NEAR ≈ $3.90. Almost all of it comes back when you close the deployment.

| What | Amount | Comes back? |
|---|---|---|
| NEAR for the deploy | about **4.33 NEAR** from the root account: 3.6 to the bank (its code is 330 KB, 3.3 NEAR of storage, plus room for about ten jobs of state), 0.44 to `team` (0.03 per agent for bid gas), 0.1 to the CFO, 0.05 to the house wallet, 0.01 each to `contributors` and `compute`, 20 USDC registrations (0.00125 each), ~0.1 gas | yes, all but the gas spent and the CFO's 0.1, through `teardown.sh` |
| USDC for the bank | about **3 USDC**, after the deploy | yes: it goes round between the house wallet, escrow, the agents and the bank, and `teardown.sh` sweeps every account back |
| NEAR AI Cloud | your key's credits, billed by NEAR AI | no |

Each job adds about 2.5 KB to the bank's state (0.025 NEAR). If you run more than ten or so jobs, send the bank another 0.1–0.2 NEAR.

Mainnet list prices are lower than testnet's: Flyers $1, Find customers $2, Website $3.

The policy is [`contracts/near/policy-mainnet.json`](contracts/near/policy-mainnet.json): it moves at most 3 USDC at a time without your co-sign, budgets 4 USDC a week for top-ups (three quarters to the house wallet, the rest to the agents) and the contract won't open a new week sooner than 7 days after the last (`epoch_secs`), pays at most 10 USDC of lots a day, keeps no reserve floor and has no promo budget. You can change any of it later with `set_policy`.

## Steps

**1. Make the root account.** Create `useparallax.near` (or another name) in a wallet such as MyNearWallet, Meteor or HOT, and send it about 4.5 NEAR. Then either import its key for near-cli (`near account import-account`) or plan to sign on a Ledger (`SIGN=ledger`).

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

It creates the accounts, deploys the bank with the mainnet policy and Circle's USDC (`17208628…36133a1`), registers everyone on USDC, hires the 14 agents and the house wallet, leaves the CFO with a function-call key on the bank only, and writes `deployments/near-mainnet.json`. Re-running skips what already exists.

**5. Fund the bank.** Send about 3 USDC from the root account into the bank. It lands in OPERATING; within five minutes the CFO opens the week, moves what the top-ups need into TOOLS and fills the house wallet.

```bash
near contract call-function as-transaction 17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1 ft_transfer_call \
  json-args '{"receiver_id":"bank.useparallax.near","amount":"3000000","msg":"deposit"}' prepaid-gas '100.0 Tgas' \
  attached-deposit '1 yoctoNEAR' sign-as useparallax.near network-config mainnet sign-with-legacy-keychain send
```

**6. Give the server its keys.** This writes the CFO's and the agents' keys to a private file outside the repo and prints only account names:

```bash
cd server && PARALLAX_NEAR_NET=mainnet node scripts/near-keys.ts
```

Paste the file's contents into the host's secret `PARALLAX_NEAR_KEYS`, then delete the file. The owner's key and the bank's key never go to the server. The house wallet's key goes too, as `house.useparallax.near`, so it can pay and accept demo jobs.

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

**8. First job.** Order Flyers ($1) from your own wallet and follow it on nearblocks.io: the escrow funding, the lots, the awards, the delivery, and your acceptance paying the winners.

**9. After judging, get the money back.**

```bash
cd contracts/near && NET=mainnet ROOT=useparallax.near PLAN_ONLY=1 ./teardown.sh   # shows every balance, sends nothing
cd contracts/near && NET=mainnet ROOT=useparallax.near ./teardown.sh              # asks you to type the root first
```

It refuses while any customer has money in escrow. Otherwise it stops the bank, takes every bucket out to the root, sweeps each account's USDC to the root, deletes the accounts (their NEAR goes to the root), and closes the bank. NEAR won't delete an account that stores more than 10 KB, so it first swaps the bank's code for [`contracts/near-cleanup`](contracts/near-cleanup) (680 bytes, callable only by the bank itself), clears the bank's storage, then deletes it. The CFO account stays, because it has no full-access key; that is its 0.1 NEAR gas allowance.

## Keys

- **Owner (`useparallax.near`).** Keep it in a wallet or on a Ledger, not on the server. It co-signs big moves, changes the policy, hires and fires, and holds the kill switch. If you imported it for the deploy, remove it from `~/.near-credentials/mainnet` afterwards.
- **Bank (`bank.useparallax.near`).** Its full-access key can replace the contract's code. The contract has no migration code, so a code change that touches stored state would break it. Treat the bank as fixed: keep its key file offline, and keep it, because `teardown.sh` needs it to close the bank. A new version means a new bank, with the money moved over by `owner_withdraw`.
- **CFO.** A function-call key on the bank only, with a 0.45 NEAR gas allowance. It can't send money anywhere the contract doesn't allow.
- **Agents.** Each pays its model bill with a USDC transfer, and NEAR's function-call keys can't attach the 1 yoctoNEAR a transfer needs, so agents hold full-access keys on the server. The CFO keeps their balances small (a few dollars each), which is the limit on what a leaked agent key can lose.

## If something goes wrong

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

- **No outside review of the contract.** It has 37 tests and the swarm simulation, and the policy caps and kill switch limit what a bug can cost. Start with small caps.
- **Paying from another chain.** 1Click quotes are dry. 1Click can deliver USDC to an account but can't name the job, so a real payment would land in Parallax's account and the server would forward it into the job's escrow: a short custody step to build and to state on the site.
- **Gas per job.** A job is about 35 transactions (lots, sealed bids, reveals, awards, inspections, delivery, acceptance), roughly 0.02–0.05 NEAR, which agents and the CFO pay. On $1 jobs that matters; a relayer for the bid transactions, or fewer lots on cheap jobs, would cut it. With the lean funding, each agent's 0.03 NEAR covers about 25 jobs.
- **The docs describe testnet.** The site's network labels and footer links follow the deployment, but the docs pages name the testnet accounts.

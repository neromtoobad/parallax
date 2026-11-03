# Parallax on NEAR mainnet: the launch checklist

The hackathon entry runs on testnet so anyone can try it with free test USDC. This file is how the same company goes live on mainnet with real USDC. Nothing here has been run on mainnet yet; every step that signs is yours.

## What it costs

| What | Amount | Where it goes |
|---|---|---|
| NEAR for the deploy | about 8.4 NEAR in the root account | 4.5 to the bank (its code is 330 KB, about 3.3 NEAR of storage), 2.3 to `team` (0.15 per agent for bid gas), 0.5 to the CFO, 0.1 each to `contributors` and `compute`, USDC registrations (0.00125 each), gas |
| USDC for the bank | about 20 USDC, after the deploy | the reserve floor (5), a week of agent tools (10), bond cover for open jobs |
| NEAR AI Cloud credits | your choice | agents' model calls (the same key works on both networks) |
| Agent Market payer (optional) | a few USDC on a separate account | outside hires, capped at $1 each and $3 a day |

The policy is [`contracts/near/policy-mainnet.json`](contracts/near/policy-mainnet.json): it moves at most 5 USDC at a time without your co-sign, budgets 10 USDC a week for tools, pays at most 20 USDC of lots a day, and has no promo budget. You can change any of it later with `set_policy`, from the CFO desk on the site or the CLI.

## Steps

**1. Make the root account.** Create `parallax.near` (or another name) in a wallet such as MyNearWallet, Meteor or HOT, and send it about 8.4 NEAR. Then either import its key for near-cli (`near account import-account`) or plan to sign on a Ledger (`SIGN=ledger`).

**2. Check everything, reading only.**

```bash
cd server && node scripts/mainnet-preflight.ts parallax.near
```

It checks the root account's balance and key, that the 19 account names are free, the USDC token, the built contract and the tools, and lists which server settings are still missing. It signs nothing.

**3. See the plan and its cost, sending nothing.**

```bash
cd contracts/near && NET=mainnet ROOT=parallax.near PLAN_ONLY=1 ./deploy.sh
```

**4. Deploy.** It asks you to type the root account before anything is sent.

```bash
cd contracts/near && NET=mainnet ROOT=parallax.near ./deploy.sh            # or add SIGN=ledger
```

It creates the accounts, deploys the bank with the mainnet policy and Circle's USDC (`17208628…36133a1`), registers everyone on USDC, hires the 14 agents, leaves the CFO with a function-call key on the bank only, and writes `deployments/near-mainnet.json`. Re-running skips what already exists.

**5. Fund the bank.** Send about 20 USDC from the root account into the bank. It lands in OPERATING, and the CFO moves what the week needs into TOOLS and BOND. Use **Fund the bank** on the CFO desk, or:

```bash
near contract call-function as-transaction 17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1 ft_transfer_call \
  json-args '{"receiver_id":"bank.parallax.near","amount":"20000000","msg":"deposit"}' prepaid-gas '100.0 Tgas' \
  attached-deposit '1 yoctoNEAR' sign-as parallax.near network-config mainnet sign-with-legacy-keychain send
```

**6. Give the server its keys.** This writes the CFO's and the agents' keys to a private file outside the repo and prints only account names:

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
| `OUTLAY_CFO` | `observe` first (it logs what it would do); `live` once its plan looks right |
| `PARALLAX_MARKET_HIRE`, `MARKET_PAYER`, `MARKET_PAYER_KEY` | optional: Agent Market hires |
| `PARALLAX_MAINNET_ACCOUNT`, `ONECLICK_JWT` | optional: quotes for paying from another chain |

**8. First job.** Order the cheapest job (Flyers, $1) from your own wallet and follow it on nearblocks.io: the escrow funding, the lots, the awards, the delivery, and your acceptance paying the winners.

## Keys

- **Owner (`parallax.near`).** Keep it in a wallet or on a Ledger, not on the server. It co-signs big moves, changes the policy, hires and fires, and holds the kill switch. If you imported it for the deploy, remove it from `~/.near-credentials/mainnet` afterwards.
- **Bank (`bank.parallax.near`).** Its full-access key can replace the contract's code. The contract has no migration code, so a code change that touches stored state would break it. Treat the bank as fixed: keep its key file offline, or delete the key to make that certain. A new version means a new bank, with the money moved over by `owner_withdraw`.
- **CFO.** A function-call key on the bank only, with a 0.45 NEAR gas allowance. It can't send money anywhere the contract doesn't allow.
- **Agents.** Each pays its model bill with a USDC transfer, and NEAR's function-call keys can't attach the 1 yoctoNEAR a transfer needs, so agents hold full-access keys on the server. The CFO keeps their balances small (a few dollars each), which is the limit on what a leaked agent key can lose.

## If something goes wrong

Stop the CFO and every agent at once (customers can still reject, get refunds and claim what they're owed):

```bash
near contract call-function as-transaction bank.parallax.near set_killed json-args '{"killed":true}' prepaid-gas '30.0 Tgas' \
  attached-deposit '0 NEAR' sign-as parallax.near network-config mainnet sign-with-legacy-keychain send
```

Take money out of a bucket (BOND keeps what open jobs need):

```bash
near contract call-function as-transaction bank.parallax.near owner_withdraw \
  json-args '{"from":"Operating","to":"parallax.near","amount":"5000000"}' prepaid-gas '30.0 Tgas' \
  attached-deposit '0 NEAR' sign-as parallax.near network-config mainnet sign-with-legacy-keychain send
```

## Not done yet

- **No outside review of the contract.** It has 27 tests and the swarm simulation, and the policy caps and kill switch limit what a bug can cost. Start with small caps.
- **Paying from another chain.** 1Click quotes are dry. 1Click can deliver USDC to an account but can't name the job, so a real payment would land in Parallax's account and the server would forward it into the job's escrow: a short custody step to build and to state on the site.
- **Gas per job.** A job is about 35 transactions (lots, sealed bids, reveals, awards, inspections, delivery, acceptance), roughly 0.02–0.05 NEAR, which agents and the CFO pay. On $1 jobs that matters; a relayer for the bid transactions, or fewer lots on cheap jobs, would cut it.
- **The docs describe testnet.** The site's network labels and footer links follow the deployment, but the docs pages name the testnet accounts.

# Security

Parallax holds real USDC on NEAR mainnet in [`bank.useparallax.near`](https://nearblocks.io/address/bank.useparallax.near). If you find a way to move money the rules in [RULES.md](RULES.md) shouldn't allow, please report it privately through [GitHub's private vulnerability reporting](https://github.com/neromtoobad/parallax/security/advisories/new) rather than in a public issue.

## What each key can do

| Key | Where it lives | What it can do |
|---|---|---|
| Owner (`useparallax.near`) | The owner's wallet, never the server | Change the policy, co-sign big moves, hire and fire, and stop everything with the kill switch |
| Bank (`bank.useparallax.near`) | Offline | Replace the contract's code. Kept only so `teardown.sh` can close the bank |
| CFO | The server | A function-call key on the bank only: price, open lots, award, inspect, top agents up inside the policy's weekly budget and per-move cap |
| Each agent and the house wallet | The server | A function-call key on the bank only. Their money is a balance inside the bank: an agent can pay model bills only to the compute account and inside the daily cap, and the house can only fund jobs |

No call from a server key attaches a deposit, so none of them can send tokens anywhere the contract doesn't allow. The worst a stolen server key can do is what the contract lets that role do, inside the caps in [`policy-mainnet.json`](contracts/near/policy-mainnet.json).

## Limits

- The contract has not had an outside audit. It has 104 tests named after the rules, a 200-job simulation, and a checker that rebuilds every auction from the chain (`node web/scripts/verify.ts --mainnet`).
- The policy caps what moves without the owner's co-sign: 3 USDC at a time, 4 USDC a week of top-ups, 10 USDC a day of lots.
- Keys never go in this repository. `deployments/` holds account names, attestation reports and hashed records only.

# Rules of the bank

The `parallax` contract on NEAR ([contracts/near/src/lib.rs](contracts/near/src/lib.rs)) enforces these. Each rule has at least one unit test, named `rule_<number>_…` after it ([tests.rs](contracts/near/src/tests.rs)), so `cargo test` in `contracts/near` reads as this list.

## People and keys

- **Owner.** A human. Sets the policy, co-signs big moves, hires and fires agents, flips the kill switch. Their key is never on the server.
- **CFO.** An AI agent with a function-call key that can only call the contract. It quotes jobs, splits them into lots, moves money inside the policy, and judges delivered work.
- **Agents.** Each is its own NEAR account (`<role>.team.parallax.testnet`), hired by the owner for a role. An agent can seal and reveal bids, deliver work, and spend what's in its own account. It cannot touch the bank.
- **Customers.** Anyone with USDC on NEAR, or on another chain through NEAR Intents.

## Money

1. USDC sent to the bank goes to **OPERATING**. A customer's job payment is held separately, in escrow.
2. The CFO can move money between buckets (OPERATING, TOOLS, BOND, RESERVE, PROMO), up to **max_move** at a time. A bigger move becomes a proposal that only the owner can co-sign.
3. RESERVE never drops below **reserve_floor**.
4. BOND always covers every bond promised on open jobs. Nobody, the owner included, can take that cover out.
5. Each week the CFO gives agents allowances whose sum stays inside **epoch_tool_budget**. It tops an agent up from TOOLS only inside that agent's allowance.
6. The **kill switch** stops the CFO and every agent at once. Customers can still reject work, get refunds and claim money owed.

## Jobs

7. The CFO opens a job at a fixed price with a bond. The bond must already be covered by BOND.
8. The customer funds the job with exactly its price. Anything extra is returned, and so is a payment for a job that isn't open.
9. The CFO delivers the job only once every lot is passed or void.
10. Only the customer can accept, ask for one revision, or reject.
11. If the customer does nothing for **accept_secs**, anyone can release the payment.
12. A rejection, or a job not delivered by its deadline, refunds the full price and pays the bond.
13. On acceptance:
    - each team winner is paid its lot pay;
    - an Agent Market winner's pay refills TOOLS, because the hiring agent already paid it on the market;
    - **contributors_bps** of the margin goes to the contributors' account;
    - the rest stays in OPERATING.

## Lots: how the team bids

14. The CFO splits a funded job into lots, each with a **reserve**, which is the most it will pay. The reserves together leave at least **min_margin_bps** of the price as margin.
15. A lot may name the roles allowed to bid. A writer can't bid on a logo.
16. **Commit (sealed).** An agent sends sha256(`lot:account:price:salt`), not its price, for `commit_secs`.
17. **Reveal.** In the next `reveal_secs` the agent reveals its price and salt. A reveal that doesn't match the commit, or is above the reserve, is refused. Committing and then not revealing costs reputation.
18. **Outside bids.** During bidding the CFO looks up research agents on the NEAR Agent Market that take calls now and enters their posted prices on the Research lot, each with a quality score: its success rate pulled toward 40% until it has a delivery record (a new agent scores 7,000; a team agent at the starting reputation scores 7,500).
    - Only quotes at or under the reserve go in, from agents with a good record: one that has failed more than one task in five, over at least five, is left out. (Without this, the swarm simulation showed a cheap agent that fails 44% of the time winning most research lots.)
    - Quotes go in only when hiring is on (a mainnet payer with USDC, a per-hire cap and a daily cap). Otherwise they are shown but not entered, because an outside win must be payable.
    - A private order's brief never leaves Parallax, so its lots stay inside the team.
    - An outside winner is hired over A2A with x402 and is paid its own quote (no runner-up price). Before the payment is signed, its 402 price must match that quote and fit both caps. The market charges only on delivery.
    - Its report becomes the research notes the team works from in that job. The CFO files it on the bank with the payment receipt (`deliver_outside`).
    - If the hire fails, the CFO fails the lot on the bank. The lot goes back up without that agent and the team bids again.
19. **Award.** Anyone can close the lot after the reveal window.
    - The lowest price per quality wins. An agent's quality comes from its reputation.
    - A team winner is paid the price that would tie the runner-up, between its own bid and the reserve. That is a Vickrey auction, so bidding your true cost is the best strategy.
    - A sole bidder is paid the reserve.
    - A lot nobody bid on is void, and the CFO can reopen it.
20. Lot pay across all jobs stays under **daily_lot_cap**.
21. **Inspection.** A pass raises the winner's reputation. A fail lowers it and puts the lot back up without that seller.
22. A team winner is paid only when the customer accepts. If the customer rejects, the agents' work was at their own risk.
23. Any payment that fails to arrive (for example, the receiver isn't registered on the token) becomes **owed**, and the receiver can claim it later.

## One round, in order

```text
CFO        open_lot(job, "Homepage copy", roles=[writer], reserve=0.60)
writer     commit(lot, sha256("7:writer.team…:350000:x9"))
linguist   commit(lot, sha256("7:linguist.team…:420000:k2"))
CFO        add_outside(lot, "copy-pro", 0.50, quality 0.80)   # Agent Market posted price
           ……… commit_secs ………
writer     reveal(lot, 0.35, "x9")
linguist   reveal(lot, 0.42, "k2")
           ……… reveal_secs ………
anyone     award(lot)  → writer wins at 0.35, is paid 0.42 (the runner-up's price)
writer     deliver(lot, sha256(files))
CFO        inspect(lot, pass)
…          (every lot passed)
CFO        submit_job(job, sha256(deliverable))
customer   accept(job) → writer +0.42, contributors 10% of margin, rest to OPERATING
```

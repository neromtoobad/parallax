//! One-off upgrade of the testnet bank as it stood on 4 Nov (TEE signers and agent balances, no open
//! crew yet). A mainnet bank is deployed fresh and never calls this.

use super::*;

#[near(serializers = [borsh])]
struct ParallaxV2 {
    owner: AccountId,
    cfo: AccountId,
    usdc: AccountId,
    policy: Policy,
    killed: bool,
    buckets: [u128; 5],
    escrowed: u128,
    bonds_outstanding: u128,
    epoch: u64,
    epoch_started: u64,
    epoch_allocated: u128,
    epoch_promo: u128,
    day: u64,
    day_lot_spend: u128,
    agents: IterableMap<AccountId, Agent>,
    jobs: IterableMap<String, Job>,
    lots: Vector<Lot>,
    proposals: Vector<Proposal>,
    owed: IterableMap<AccountId, u128>,
    owed_total: u128,
    balances: IterableMap<AccountId, u128>,
    held: u128,
    day_model_spend: u128,
    signers: IterableMap<String, Signer>,
}

#[near]
impl Parallax {
    /// Reads the 4 Nov state and opens the crew under `operator`.
    #[private]
    #[init(ignore_state)]
    pub fn migrate(operator: AccountId) -> Self {
        let o: ParallaxV2 = env::state_read().unwrap_or_else(|| env::panic_str("no state to migrate"));
        emit("operator", json!({"operator": operator, "migrated": true}));
        Self {
            owner: o.owner,
            cfo: o.cfo,
            usdc: o.usdc,
            policy: o.policy,
            killed: o.killed,
            buckets: o.buckets,
            escrowed: o.escrowed,
            bonds_outstanding: o.bonds_outstanding,
            epoch: o.epoch,
            epoch_started: o.epoch_started,
            epoch_allocated: o.epoch_allocated,
            epoch_promo: o.epoch_promo,
            day: o.day,
            day_lot_spend: o.day_lot_spend,
            agents: o.agents,
            jobs: o.jobs,
            lots: o.lots,
            proposals: o.proposals,
            owed: o.owed,
            owed_total: o.owed_total,
            balances: o.balances,
            held: o.held,
            day_model_spend: o.day_model_spend,
            signers: o.signers,
            operator: Some(operator),
            crew: IterableMap::new(b"c"),
        }
    }
}

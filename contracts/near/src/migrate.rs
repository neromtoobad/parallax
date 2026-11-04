//! One-off upgrade of the testnet bank deployed on 2 Nov (before the week lock, agent balances, the
//! daily model cap and TEE signers). A mainnet bank is deployed fresh and never calls this.

use super::*;

#[near(serializers = [borsh])]
struct PolicyV1 {
    reserve_floor: U128,
    max_move: U128,
    epoch_tool_budget: U128,
    promo_cap: U128,
    daily_lot_cap: U128,
    min_margin_bps: u16,
    contributors_bps: u16,
    contributors: AccountId,
    accept_secs: u32,
    revision_secs: u32,
    commit_secs: u32,
    reveal_secs: u32,
}

#[near(serializers = [borsh])]
struct ParallaxV1 {
    owner: AccountId,
    cfo: AccountId,
    usdc: AccountId,
    policy: PolicyV1,
    killed: bool,
    buckets: [u128; 5],
    escrowed: u128,
    bonds_outstanding: u128,
    epoch: u64,
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
}

#[near]
impl Parallax {
    /// Reads the 2 Nov state and adds what the new rules need. The current week counts from now.
    #[private]
    #[init(ignore_state)]
    pub fn migrate(epoch_secs: u32, compute: AccountId, daily_model_cap: U128, require_tee: bool) -> Self {
        let o: ParallaxV1 = env::state_read().unwrap_or_else(|| env::panic_str("no state to migrate"));
        let p = o.policy;
        let policy = Policy {
            reserve_floor: p.reserve_floor,
            max_move: p.max_move,
            epoch_tool_budget: p.epoch_tool_budget,
            promo_cap: p.promo_cap,
            daily_lot_cap: p.daily_lot_cap,
            min_margin_bps: p.min_margin_bps,
            contributors_bps: p.contributors_bps,
            contributors: p.contributors,
            accept_secs: p.accept_secs,
            revision_secs: p.revision_secs,
            commit_secs: p.commit_secs,
            reveal_secs: p.reveal_secs,
            epoch_secs,
            compute,
            daily_model_cap,
            require_tee,
        };
        check_policy(&policy);
        emit("policy", json!({"by": o.owner, "policy": policy, "migrated": true}));
        Self {
            owner: o.owner,
            cfo: o.cfo,
            usdc: o.usdc,
            policy,
            killed: o.killed,
            buckets: o.buckets,
            escrowed: o.escrowed,
            bonds_outstanding: o.bonds_outstanding,
            epoch: o.epoch,
            epoch_started: env::block_timestamp(),
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
            balances: IterableMap::new(b"b"),
            held: 0,
            day_model_spend: 0,
            signers: IterableMap::new(b"s"),
        }
    }
}

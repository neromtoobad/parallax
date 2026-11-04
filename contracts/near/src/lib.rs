//! Parallax on NEAR: the bank of a company run by AI agents.
//!
//! One contract holds the company's USDC (NEP-141) and enforces three things:
//!
//! 1. **The treasury.** Every unit sits in one of five buckets. The CFO agent
//!    moves money between buckets and funds agents inside the owner's policy;
//!    anything bigger is a proposal the owner co-signs. A kill switch stops
//!    the agents at once, and every accepted job sends a fixed share of its
//!    margin to the contributors' account.
//! 2. **Job escrow.** A customer funds a quoted job with `ft_transfer_call`.
//!    The money is released only when the customer accepts (or stays silent
//!    past the window). A rejection or a missed deadline refunds the price and
//!    pays the customer a bond from the BOND bucket.
//! 3. **Lots.** Each job is split into lots. Team agents seal bids on the lots
//!    they can do and Agent Market agents enter with their posted prices. The
//!    lowest price per quality wins, and a team winner is paid the runner-up's
//!    price (Vickrey), capped by the lot's reserve. The CFO's inspector passes
//!    or fails the work; a fail re-auctions the lot without that seller.
//!
//! RULES.md is the plain-language version.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{IterableMap, Vector};
use near_sdk::{
    env, ext_contract, near, require, AccountId, Gas, NearToken, PanicOnDefault, PromiseError, PromiseOrValue,
};

#[cfg(test)]
mod tests;

const BPS: u128 = 10_000;
const NS: u64 = 1_000_000_000;
const DAY: u64 = 86_400 * NS;
const REP_START: u16 = 500;
const REP_MAX: u16 = 1_000;
const REP_PASS: u16 = 10;
const REP_FAIL: u16 = 50;
const REP_NO_REVEAL: u16 = 20;
/// Below this an agent is on probation and cannot bid.
const REP_MIN_BID: u16 = 200;
const FT_GAS: Gas = Gas::from_tgas(15);
const CB_GAS: Gas = Gas::from_tgas(10);

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

// ------------------------------------------------------------------ types

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Bucket {
    Operating,
    Tools,
    Bond,
    Reserve,
    Promo,
}

impl Bucket {
    fn i(self) -> usize {
        self as usize
    }
}

/// The owner's rules. The CFO cannot change any of them.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Policy {
    /// RESERVE never goes below this.
    pub reserve_floor: U128,
    /// The largest single move or payment the CFO may make alone.
    pub max_move: U128,
    /// Cap on the sum of agent allowances per epoch.
    pub epoch_tool_budget: U128,
    /// Cap on free-job spend per epoch.
    pub promo_cap: U128,
    /// Cap on what lots may pay out per day, across all jobs.
    pub daily_lot_cap: U128,
    /// Lot reserves may use at most (10000 - min_margin_bps) of a job's price.
    pub min_margin_bps: u16,
    /// Share of each accepted job's margin that goes to the contributors' account.
    pub contributors_bps: u16,
    pub contributors: AccountId,
    pub accept_secs: u32,
    pub revision_secs: u32,
    pub commit_secs: u32,
    pub reveal_secs: u32,
    /// The shortest a week can be: the CFO can't open the next one sooner, so it can't reset
    /// epoch_tool_budget and promo_cap early.
    pub epoch_secs: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Agent {
    pub role: String,
    pub active: bool,
    pub rep: u16,
    pub allowance_epoch: U64,
    pub allowance: U128,
    pub topped_up: U128,
    pub earned: U128,
    pub wins: u32,
    pub fails: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
pub enum JobState {
    Open,
    Funded,
    Submitted,
    Accepted,
    Rejected,
    Refunded,
    Cancelled,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Job {
    pub id: String,
    pub customer: AccountId,
    pub amount: U128,
    pub bond: U128,
    pub fund_by: U64,
    pub deliver_by: U64,
    pub accept_by: U64,
    pub revised: bool,
    pub state: JobState,
    /// sha256 of the brief and acceptance criteria shown before payment.
    pub spec_hash: String,
    pub deliverable_hash: String,
    pub lots: Vec<u64>,
    pub reserved: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
pub enum Seller {
    Team(AccountId),
    Outside(String),
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
pub enum LotStatus {
    Bidding,
    Awarded,
    Submitted,
    Passed,
    Void,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Commit {
    pub agent: AccountId,
    pub hash: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Reveal {
    pub agent: AccountId,
    pub price: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct OutsideBid {
    pub handle: String,
    pub price: U128,
    pub quality_bps: u16,
    /// Where the quote came from, e.g. the agent's A2A endpoint.
    pub quote_ref: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Lot {
    pub id: u64,
    pub job: String,
    pub title: String,
    /// Roles allowed to bid (empty: any active agent).
    pub roles: Vec<String>,
    pub reserve: U128,
    pub round: u8,
    pub status: LotStatus,
    pub commit_end: U64,
    pub reveal_end: U64,
    pub commits: Vec<Commit>,
    pub reveals: Vec<Reveal>,
    pub outside: Vec<OutsideBid>,
    pub excluded: Vec<String>,
    pub winner: Option<Seller>,
    pub bid: U128,
    pub pay: U128,
    pub deliverable: String,
    pub receipt: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub enum Kind {
    Move { from: Bucket, to: Bucket },
    Hire { role: String },
    Fire,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Proposal {
    pub id: u64,
    pub kind: Kind,
    pub who: Option<AccountId>,
    pub amount: U128,
    pub reason: String,
    pub done: bool,
}

#[near(serializers = [json])]
pub struct Overview {
    pub owner: AccountId,
    pub cfo: AccountId,
    pub usdc: AccountId,
    pub killed: bool,
    pub buckets: [U128; 5],
    pub escrowed: U128,
    pub bonds_outstanding: U128,
    pub owed: U128,
    pub epoch: U64,
    /// When this week was opened (nanoseconds; 0 before the first open_epoch), and when the next may open.
    pub epoch_started: U64,
    pub next_epoch_at: U64,
    pub epoch_allocated: U128,
    pub epoch_promo: U128,
    pub day_lot_spend: U128,
    pub agents: u32,
    pub jobs: u32,
    pub lots: u32,
    pub proposals: u32,
}

// ------------------------------------------------------------------ state

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Parallax {
    owner: AccountId,
    cfo: AccountId,
    usdc: AccountId,
    policy: Policy,
    killed: bool,
    buckets: [u128; 5],
    /// Customer money held for funded jobs.
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
    /// Transfers that failed (e.g. the receiver has no storage on the token), claimable later.
    owed: IterableMap<AccountId, u128>,
    owed_total: u128,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// The commit an agent must send: sha256("lot:account:price:salt").
pub fn commit_hash(lot: u64, agent: &AccountId, price: u128, salt: &str) -> String {
    hex(&env::sha256(format!("{}:{}:{}:{}", lot, agent, price, salt).as_bytes()))
}

fn emit(event: &str, data: Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({"standard": "parallax", "version": "1.0.0", "event": event, "data": [data]})
    ));
}

fn quality(rep: u16) -> u128 {
    5_000 + 5 * rep as u128
}

fn check_policy(p: &Policy) {
    require!((p.min_margin_bps as u128) < BPS, "min_margin_bps must be below 10000");
    require!((p.contributors_bps as u128) <= BPS, "contributors_bps above 10000");
    require!(p.commit_secs > 0 && p.reveal_secs > 0, "bidding windows must be positive");
    require!(p.accept_secs > 0 && p.revision_secs > 0, "job windows must be positive");
    require!(p.epoch_secs > 0, "a week must have a length");
}

fn seller_key(s: &Seller) -> String {
    match s {
        Seller::Team(a) => a.to_string(),
        Seller::Outside(h) => format!("outside:{}", h),
    }
}

#[near]
impl Parallax {
    #[init]
    pub fn new(owner: AccountId, cfo: AccountId, usdc: AccountId, policy: Policy) -> Self {
        check_policy(&policy);
        emit("policy", json!({"by": owner, "policy": policy}));
        Self {
            owner,
            cfo,
            usdc,
            policy,
            killed: false,
            buckets: [0; 5],
            escrowed: 0,
            bonds_outstanding: 0,
            epoch: 1,
            // The first week can open at once; each one after waits epoch_secs.
            epoch_started: 0,
            epoch_allocated: 0,
            epoch_promo: 0,
            day: 0,
            day_lot_spend: 0,
            agents: IterableMap::new(b"a"),
            jobs: IterableMap::new(b"j"),
            lots: Vector::new(b"l"),
            proposals: Vector::new(b"p"),
            owed: IterableMap::new(b"o"),
            owed_total: 0,
        }
    }

    // ============================================================ money in

    /// USDC arrives with `ft_transfer_call`. `msg` says what it is for:
    /// `job:<id>` funds that job (exactly its price; any extra is returned),
    /// anything else is a deposit into OPERATING.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.usdc, "only USDC");
        if let Some(id) = msg.strip_prefix("job:") {
            let mut j = match self.jobs.get(id).cloned() {
                Some(j) => j,
                None => return PromiseOrValue::Value(amount),
            };
            let now = env::block_timestamp();
            if j.state != JobState::Open || now > j.fund_by.0 || amount.0 < j.amount.0 {
                emit("fund_refused", json!({"job": id, "from": sender_id, "amount": amount}));
                return PromiseOrValue::Value(amount);
            }
            j.state = JobState::Funded;
            self.escrowed += j.amount.0;
            let extra = amount.0 - j.amount.0;
            emit("funded", json!({"job": id, "payer": sender_id, "amount": j.amount}));
            self.jobs.insert(id.to_string(), j);
            return PromiseOrValue::Value(U128(extra));
        }
        self.buckets[Bucket::Operating.i()] += amount.0;
        emit("deposit", json!({"from": sender_id, "amount": amount, "memo": msg}));
        PromiseOrValue::Value(U128(0))
    }

    // ============================================================ CFO: treasury

    pub fn move_funds(&mut self, from: Bucket, to: Bucket, amount: U128, reason: String) {
        self.only_cfo();
        self.alive();
        require!(amount.0 <= self.policy.max_move.0, "over max_move: propose it to the owner");
        self.do_move(from, to, amount.0, &reason, false);
    }

    /// Free first jobs are paid from PROMO, moved into TOOLS, capped per epoch.
    pub fn promo_to_tools(&mut self, amount: U128, job: String) {
        self.only_cfo();
        self.alive();
        require!(self.epoch_promo + amount.0 <= self.policy.promo_cap.0, "over promo cap");
        self.epoch_promo += amount.0;
        self.do_move(Bucket::Promo, Bucket::Tools, amount.0, &job, false);
    }

    /// A new week. `plan_hash` seals the CFO's allocation record, published off chain.
    pub fn open_epoch(&mut self, plan_hash: String) {
        self.only_cfo();
        self.alive();
        let now = env::block_timestamp();
        require!(now >= self.next_epoch_at(), "this week isn't over yet");
        self.epoch += 1;
        self.epoch_started = now;
        self.epoch_allocated = 0;
        self.epoch_promo = 0;
        emit("epoch", json!({"epoch": U64(self.epoch), "plan": plan_hash}));
    }

    pub fn set_allowance(&mut self, agent: AccountId, amount: U128) {
        self.only_cfo();
        self.alive();
        let mut a = self.agent(&agent);
        require!(a.active, "agent not active");
        if a.allowance_epoch.0 != self.epoch {
            a.allowance_epoch = U64(self.epoch);
            a.allowance = U128(0);
            a.topped_up = U128(0);
        }
        // Money already sent this week can't be clawed back.
        let amount = amount.0.max(a.topped_up.0);
        self.epoch_allocated = self.epoch_allocated - a.allowance.0 + amount;
        require!(self.epoch_allocated <= self.policy.epoch_tool_budget.0, "over the epoch tool budget");
        a.allowance = U128(amount);
        self.agents.insert(agent.clone(), a);
        emit("allowance", json!({"agent": agent, "epoch": U64(self.epoch), "amount": U128(amount)}));
    }

    /// Fund an agent's own account from TOOLS so it can pay for its inference and hires.
    pub fn top_up(&mut self, agent: AccountId, amount: U128, reason: String) {
        self.only_cfo();
        self.alive();
        let mut a = self.agent(&agent);
        require!(a.active, "agent not active");
        require!(a.allowance_epoch.0 == self.epoch && a.topped_up.0 + amount.0 <= a.allowance.0, "over allowance");
        self.take(Bucket::Tools, amount.0);
        a.topped_up = U128(a.topped_up.0 + amount.0);
        self.agents.insert(agent.clone(), a);
        emit("top_up", json!({"agent": agent, "epoch": U64(self.epoch), "amount": amount, "reason": reason}));
        self.pay_out(agent, amount.0, "top_up");
    }

    pub fn propose(&mut self, kind: Kind, who: Option<AccountId>, amount: U128, reason: String) -> u64 {
        self.only_cfo();
        let id = self.proposals.len() as u64;
        self.proposals.push(Proposal { id, kind: kind.clone(), who: who.clone(), amount, reason: reason.clone(), done: false });
        emit("proposed", json!({"id": U64(id), "kind": kind, "who": who, "amount": amount, "reason": reason}));
        id
    }

    // ============================================================ owner

    pub fn co_sign(&mut self, id: u64) {
        self.only_owner();
        let mut p = self.proposals.get(id as u32).cloned().unwrap_or_else(|| env::panic_str("no such proposal"));
        require!(!p.done, "already done");
        p.done = true;
        match &p.kind {
            Kind::Move { from, to } => self.do_move(*from, *to, p.amount.0, &p.reason, true),
            Kind::Hire { role } => self.do_hire(p.who.clone().expect("who"), role.clone()),
            Kind::Fire => self.do_fire(p.who.clone().expect("who")),
        }
        self.proposals.replace(id as u32, p);
        emit("co_signed", json!({"id": U64(id)}));
    }

    pub fn hire(&mut self, agent: AccountId, role: String) {
        self.only_owner();
        self.do_hire(agent, role);
    }

    pub fn fire(&mut self, agent: AccountId) {
        self.only_owner();
        self.do_fire(agent);
    }

    pub fn set_policy(&mut self, policy: Policy) {
        self.only_owner();
        check_policy(&policy);
        self.policy = policy.clone();
        emit("policy", json!({"by": self.owner, "policy": policy}));
    }

    /// The kill switch. While on, the CFO and the agents can do nothing;
    /// customers can still reject, get refunds and claim what they're owed.
    pub fn set_killed(&mut self, killed: bool) {
        self.only_owner();
        self.killed = killed;
        emit("killed", json!({"killed": killed}));
    }

    pub fn set_cfo(&mut self, cfo: AccountId) {
        self.only_owner();
        self.cfo = cfo.clone();
        emit("cfo", json!({"cfo": cfo}));
    }

    pub fn set_owner(&mut self, owner: AccountId) {
        self.only_owner();
        self.owner = owner.clone();
        emit("owner", json!({"owner": owner}));
    }

    /// The owner can take money out, but never the money backing customers' bonds.
    pub fn owner_withdraw(&mut self, from: Bucket, to: AccountId, amount: U128) {
        self.only_owner();
        self.take(from, amount.0);
        if from == Bucket::Bond {
            require!(self.buckets[Bucket::Bond.i()] >= self.bonds_outstanding, "would uncover bonds");
        }
        emit("owner_withdraw", json!({"from": from, "to": to, "amount": amount}));
        self.pay_out(to, amount.0, "owner_withdraw");
    }

    // ============================================================ jobs (escrow)

    /// The CFO opens a quoted job. Its bond is reserved now, so every open quote is covered.
    pub fn open_job(&mut self, id: String, customer: AccountId, amount: U128, bond: U128, spec_hash: String, fund_secs: u32, deliver_secs: u32) {
        self.only_cfo();
        self.alive();
        require!(self.jobs.get(&id).is_none(), "job exists");
        require!(amount.0 > 0, "price must be positive");
        self.bonds_outstanding += bond.0;
        require!(self.buckets[Bucket::Bond.i()] >= self.bonds_outstanding, "BOND can't cover this bond");
        let now = env::block_timestamp();
        let j = Job {
            id: id.clone(),
            customer: customer.clone(),
            amount,
            bond,
            fund_by: U64(now + fund_secs as u64 * NS),
            deliver_by: U64(now + deliver_secs as u64 * NS),
            accept_by: U64(0),
            revised: false,
            state: JobState::Open,
            spec_hash: spec_hash.clone(),
            deliverable_hash: String::new(),
            lots: vec![],
            reserved: U128(0),
        };
        self.jobs.insert(id.clone(), j);
        emit("job", json!({"job": id, "customer": customer, "amount": amount, "bond": bond, "spec": spec_hash}));
    }

    /// An unfunded quote expires (or the CFO withdraws it); its bond is released.
    pub fn cancel_unfunded(&mut self, id: String) {
        let mut j = self.job(&id);
        require!(j.state == JobState::Open, "not open");
        require!(env::block_timestamp() > j.fund_by.0 || env::predecessor_account_id() == self.cfo, "too early");
        j.state = JobState::Cancelled;
        self.bonds_outstanding -= j.bond.0;
        self.jobs.insert(id.clone(), j);
        emit("cancelled", json!({"job": id}));
    }

    pub fn submit_job(&mut self, id: String, deliverable_hash: String) {
        self.only_cfo();
        self.alive();
        let mut j = self.job(&id);
        require!(j.state == JobState::Funded, "not funded");
        require!(env::block_timestamp() <= j.deliver_by.0, "past the deadline");
        for l in j.lots.iter() {
            let s = self.lot(*l).status;
            require!(s == LotStatus::Passed || s == LotStatus::Void, "a lot is still open");
        }
        j.state = JobState::Submitted;
        j.deliverable_hash = deliverable_hash.clone();
        j.accept_by = U64(env::block_timestamp() + self.policy.accept_secs as u64 * NS);
        self.jobs.insert(id.clone(), j);
        emit("submitted", json!({"job": id, "deliverable": deliverable_hash}));
    }

    pub fn accept(&mut self, id: String) {
        let j = self.job(&id);
        require!(env::predecessor_account_id() == j.customer, "only the customer");
        require!(j.state == JobState::Submitted, "nothing to accept");
        self.release(j, false);
    }

    /// Silence means yes: after the acceptance window anyone can release payment.
    pub fn auto_release(&mut self, id: String) {
        let j = self.job(&id);
        require!(j.state == JobState::Submitted, "nothing to release");
        require!(env::block_timestamp() > j.accept_by.0, "too early");
        self.release(j, true);
    }

    pub fn request_revision(&mut self, id: String) {
        let mut j = self.job(&id);
        require!(env::predecessor_account_id() == j.customer, "only the customer");
        require!(j.state == JobState::Submitted, "nothing to revise");
        require!(!j.revised, "already revised once");
        require!(env::block_timestamp() <= j.accept_by.0, "too late");
        j.revised = true;
        j.state = JobState::Funded;
        j.deliver_by = U64(env::block_timestamp() + self.policy.revision_secs as u64 * NS);
        self.jobs.insert(id.clone(), j);
        emit("revision", json!({"job": id}));
    }

    /// Not accepted: the full price back, plus the bond.
    pub fn reject(&mut self, id: String) {
        let mut j = self.job(&id);
        require!(env::predecessor_account_id() == j.customer, "only the customer");
        require!(j.state == JobState::Submitted, "nothing to reject");
        require!(env::block_timestamp() <= j.accept_by.0, "too late");
        j.state = JobState::Rejected;
        self.refund(j, "rejected");
    }

    /// Parallax missed its deadline: anyone can trigger the refund and bond for the customer.
    pub fn refund_late(&mut self, id: String) {
        let mut j = self.job(&id);
        require!(j.state == JobState::Funded, "not in progress");
        require!(env::block_timestamp() > j.deliver_by.0, "too early");
        j.state = JobState::Refunded;
        self.refund(j, "late");
    }

    // ============================================================ lots

    /// The CFO splits a funded job into lots. Reserves may use at most
    /// (1 - min_margin) of the job's price.
    pub fn open_lot(&mut self, job: String, title: String, roles: Vec<String>, reserve: U128) -> u64 {
        self.only_cfo();
        self.alive();
        let mut j = self.job(&job);
        require!(j.state == JobState::Funded, "job not funded");
        let budget = j.amount.0 * (BPS - self.policy.min_margin_bps as u128) / BPS;
        require!(j.reserved.0 + reserve.0 <= budget, "lot reserves would eat the margin");
        let id = self.lots.len() as u64;
        let (commit_end, reveal_end) = self.windows();
        self.lots.push(Lot {
            id,
            job: job.clone(),
            title: title.clone(),
            roles: roles.clone(),
            reserve,
            round: 1,
            status: LotStatus::Bidding,
            commit_end: U64(commit_end),
            reveal_end: U64(reveal_end),
            commits: vec![],
            reveals: vec![],
            outside: vec![],
            excluded: vec![],
            winner: None,
            bid: U128(0),
            pay: U128(0),
            deliverable: String::new(),
            receipt: String::new(),
        });
        j.lots.push(id);
        j.reserved = U128(j.reserved.0 + reserve.0);
        self.jobs.insert(job.clone(), j);
        emit("lot", json!({"lot": U64(id), "job": job, "title": title, "roles": roles, "reserve": reserve, "commit_end": U64(commit_end), "reveal_end": U64(reveal_end)}));
        id
    }

    pub fn commit(&mut self, lot: u64, hash: String) {
        self.alive();
        let me = env::predecessor_account_id();
        let a = self.agent(&me);
        require!(a.active, "agent not active");
        require!(a.rep >= REP_MIN_BID, "on probation");
        let mut l = self.lot(lot);
        require!(l.status == LotStatus::Bidding, "not bidding");
        require!(env::block_timestamp() < l.commit_end.0, "commit window closed");
        require!(l.roles.is_empty() || l.roles.contains(&a.role), "not this agent's kind of work");
        require!(!l.excluded.contains(&me.to_string()), "excluded from this lot");
        require!(hash.len() == 64, "hash must be 32 bytes hex");
        l.commits.retain(|c| c.agent != me);
        l.commits.push(Commit { agent: me.clone(), hash });
        self.lots.replace(lot as u32, l);
        emit("commit", json!({"lot": U64(lot), "agent": me}));
    }

    pub fn reveal(&mut self, lot: u64, price: U128, salt: String) {
        self.alive();
        let me = env::predecessor_account_id();
        let mut l = self.lot(lot);
        require!(l.status == LotStatus::Bidding, "not bidding");
        let now = env::block_timestamp();
        require!(now >= l.commit_end.0 && now < l.reveal_end.0, "not in the reveal window");
        let c = l.commits.iter().find(|c| c.agent == me).unwrap_or_else(|| env::panic_str("no commit"));
        require!(c.hash == commit_hash(lot, &me, price.0, &salt), "reveal does not match commit");
        require!(price.0 <= l.reserve.0, "bid above reserve");
        require!(l.reveals.iter().all(|r| r.agent != me), "already revealed");
        l.reveals.push(Reveal { agent: me.clone(), price });
        self.lots.replace(lot as u32, l);
        emit("reveal", json!({"lot": U64(lot), "agent": me, "price": price}));
    }

    /// The CFO enters an Agent Market agent's posted price as a bid.
    pub fn add_outside(&mut self, lot: u64, handle: String, price: U128, quality_bps: u16, quote_ref: String) {
        self.only_cfo();
        self.alive();
        let mut l = self.lot(lot);
        require!(l.status == LotStatus::Bidding, "not bidding");
        require!(env::block_timestamp() < l.reveal_end.0, "bidding closed");
        require!(price.0 <= l.reserve.0, "quote above reserve");
        require!((1_000..=10_000).contains(&quality_bps), "quality_bps out of range");
        require!(!l.excluded.contains(&format!("outside:{}", handle)), "excluded from this lot");
        l.outside.retain(|b| b.handle != handle);
        l.outside.push(OutsideBid { handle: handle.clone(), price, quality_bps, quote_ref });
        self.lots.replace(lot as u32, l);
        emit("outside_bid", json!({"lot": U64(lot), "handle": handle, "price": price, "quality_bps": quality_bps}));
    }

    /// Anyone may close a lot once reveals are over.
    pub fn award(&mut self, lot: u64) {
        self.alive();
        let mut l = self.lot(lot);
        require!(l.status == LotStatus::Bidding, "not bidding");
        require!(env::block_timestamp() >= l.reveal_end.0, "reveals still open");

        for c in l.commits.iter() {
            if l.reveals.iter().all(|r| r.agent != c.agent) {
                if let Some(mut a) = self.agents.get(&c.agent).cloned() {
                    a.rep = a.rep.saturating_sub(REP_NO_REVEAL);
                    self.agents.insert(c.agent.clone(), a);
                }
            }
        }

        // Score = price / quality, compared by cross-multiplying.
        let mut bids: Vec<(Seller, u128, u128)> = vec![];
        for r in l.reveals.iter() {
            let rep = self.agents.get(&r.agent).map(|a| a.rep).unwrap_or(0);
            bids.push((Seller::Team(r.agent.clone()), r.price.0, quality(rep)));
        }
        for b in l.outside.iter() {
            bids.push((Seller::Outside(b.handle.clone()), b.price.0, b.quality_bps as u128));
        }
        if bids.is_empty() {
            l.status = LotStatus::Void;
            self.lots.replace(lot as u32, l);
            emit("void", json!({"lot": U64(lot)}));
            return;
        }
        bids.sort_by(|a, b| {
            (a.1 * b.2)
                .cmp(&(b.1 * a.2))
                .then_with(|| matches!(b.0, Seller::Team(_)).cmp(&matches!(a.0, Seller::Team(_))))
                .then_with(|| seller_key(&a.0).cmp(&seller_key(&b.0)))
        });
        let (winner, price, q) = bids[0].clone();
        let pay = match &winner {
            Seller::Outside(_) => price,
            Seller::Team(_) => match bids.get(1) {
                Some((_, p2, q2)) => (p2 * q / q2).clamp(price, l.reserve.0),
                None => l.reserve.0,
            },
        };
        self.roll_day();
        require!(self.day_lot_spend + pay <= self.policy.daily_lot_cap.0, "daily lot cap reached");
        self.day_lot_spend += pay;
        l.status = LotStatus::Awarded;
        l.winner = Some(winner.clone());
        l.bid = U128(price);
        l.pay = U128(pay);
        self.lots.replace(lot as u32, l);
        emit("award", json!({"lot": U64(lot), "winner": winner, "bid": U128(price), "pay": U128(pay), "bidders": bids.len()}));
    }

    /// A void lot can go back up for another round.
    pub fn reopen(&mut self, lot: u64) {
        self.only_cfo();
        self.alive();
        let mut l = self.lot(lot);
        require!(l.status == LotStatus::Void, "not void");
        self.restart(&mut l);
        let round = l.round;
        self.lots.replace(lot as u32, l);
        emit("reopen", json!({"lot": U64(lot), "round": round}));
    }

    /// A team winner files its work (the hash of its files).
    pub fn deliver(&mut self, lot: u64, deliverable: String) {
        self.alive();
        let me = env::predecessor_account_id();
        let mut l = self.lot(lot);
        require!(l.status == LotStatus::Awarded, "not awarded");
        require!(l.winner == Some(Seller::Team(me.clone())), "not the winner");
        l.status = LotStatus::Submitted;
        l.deliverable = deliverable.clone();
        self.lots.replace(lot as u32, l);
        emit("deliver", json!({"lot": U64(lot), "by": me, "deliverable": deliverable}));
    }

    /// The CFO files an outside agent's work with its payment receipt.
    pub fn deliver_outside(&mut self, lot: u64, deliverable: String, receipt: String) {
        self.only_cfo();
        self.alive();
        let mut l = self.lot(lot);
        require!(l.status == LotStatus::Awarded, "not awarded");
        require!(matches!(l.winner, Some(Seller::Outside(_))), "winner is on the team");
        l.status = LotStatus::Submitted;
        l.deliverable = deliverable.clone();
        l.receipt = receipt.clone();
        self.lots.replace(lot as u32, l);
        emit("deliver", json!({"lot": U64(lot), "deliverable": deliverable, "receipt": receipt}));
    }

    /// The inspector's verdict. A pass books the pay; a fail re-auctions without the seller.
    pub fn inspect(&mut self, lot: u64, pass: bool, note: String) {
        self.only_cfo();
        self.alive();
        let mut l = self.lot(lot);
        require!(l.status == LotStatus::Submitted, "nothing delivered");
        let winner = l.winner.clone().unwrap();
        if pass {
            if let Seller::Team(a) = &winner {
                let mut ag = self.agent(a);
                ag.wins += 1;
                ag.rep = (ag.rep + REP_PASS).min(REP_MAX);
                self.agents.insert(a.clone(), ag);
            }
            l.status = LotStatus::Passed;
            emit("pass", json!({"lot": U64(lot), "winner": winner, "pay": l.pay, "note": note}));
        } else {
            match &winner {
                Seller::Team(a) => {
                    let mut ag = self.agent(a);
                    ag.fails += 1;
                    ag.rep = ag.rep.saturating_sub(REP_FAIL);
                    self.agents.insert(a.clone(), ag);
                    l.excluded.push(a.to_string());
                }
                Seller::Outside(h) => l.excluded.push(format!("outside:{}", h)),
            }
            self.roll_day();
            self.day_lot_spend = self.day_lot_spend.saturating_sub(l.pay.0);
            self.restart(&mut l);
            emit("fail", json!({"lot": U64(lot), "seller": winner, "note": note, "round": l.round}));
        }
        self.lots.replace(lot as u32, l);
    }

    /// Money that couldn't be delivered earlier (no storage on the token, say) can be claimed.
    pub fn claim(&mut self) {
        let me = env::predecessor_account_id();
        let amount = self.owed.remove(&me).unwrap_or(0);
        require!(amount > 0, "nothing owed");
        self.owed_total -= amount;
        self.pay_out(me, amount, "claim");
    }

    #[private]
    pub fn on_paid(&mut self, to: AccountId, amount: U128, what: String, #[callback_result] r: Result<(), PromiseError>) {
        if r.is_err() {
            let o = self.owed.get(&to).copied().unwrap_or(0);
            self.owed.insert(to.clone(), o + amount.0);
            self.owed_total += amount.0;
            emit("owed", json!({"to": to, "amount": amount, "what": what}));
        }
    }

    // ============================================================ views

    pub fn overview(&self) -> Overview {
        Overview {
            owner: self.owner.clone(),
            cfo: self.cfo.clone(),
            usdc: self.usdc.clone(),
            killed: self.killed,
            buckets: self.buckets.map(U128),
            escrowed: U128(self.escrowed),
            bonds_outstanding: U128(self.bonds_outstanding),
            owed: U128(self.owed_total),
            epoch: U64(self.epoch),
            epoch_started: U64(self.epoch_started),
            next_epoch_at: U64(self.next_epoch_at()),
            epoch_allocated: U128(self.epoch_allocated),
            epoch_promo: U128(self.epoch_promo),
            day_lot_spend: U128(self.day_lot_spend),
            agents: self.agents.len(),
            jobs: self.jobs.len(),
            lots: self.lots.len(),
            proposals: self.proposals.len(),
        }
    }

    pub fn get_policy(&self) -> Policy {
        self.policy.clone()
    }

    pub fn get_agent(&self, account: AccountId) -> Option<Agent> {
        self.agents.get(&account).cloned()
    }

    pub fn list_agents(&self) -> Vec<(AccountId, Agent)> {
        self.agents.iter().map(|(a, s)| (a.clone(), s.clone())).collect()
    }

    pub fn get_job(&self, id: String) -> Option<Job> {
        self.jobs.get(&id).cloned()
    }

    pub fn get_lot(&self, id: u64) -> Option<Lot> {
        self.lots.get(id as u32).cloned()
    }

    pub fn list_lots(&self, from: u64, limit: u64) -> Vec<Lot> {
        (from..(from + limit).min(self.lots.len() as u64)).map(|i| self.lot(i)).collect()
    }

    pub fn job_lots(&self, id: String) -> Vec<Lot> {
        self.jobs.get(&id).map(|j| j.lots.iter().map(|l| self.lot(*l)).collect()).unwrap_or_default()
    }

    pub fn list_proposals(&self, from: u64, limit: u64) -> Vec<Proposal> {
        (from..(from + limit).min(self.proposals.len() as u64))
            .filter_map(|i| self.proposals.get(i as u32).cloned())
            .collect()
    }

    pub fn owed_to(&self, account: AccountId) -> U128 {
        U128(self.owed.get(&account).copied().unwrap_or(0))
    }

    pub fn hash_bid(&self, lot: u64, agent: AccountId, price: U128, salt: String) -> String {
        commit_hash(lot, &agent, price.0, &salt)
    }
}

// ------------------------------------------------------------------ internals

impl Parallax {
    /// When the next week may open: at once before the first open_epoch, then epoch_secs after the last.
    fn next_epoch_at(&self) -> u64 {
        if self.epoch_started == 0 {
            0
        } else {
            self.epoch_started + self.policy.epoch_secs as u64 * NS
        }
    }

    fn only_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the owner");
    }

    fn only_cfo(&self) {
        require!(env::predecessor_account_id() == self.cfo, "only the CFO");
    }

    fn alive(&self) {
        require!(!self.killed, "the kill switch is on");
    }

    fn agent(&self, a: &AccountId) -> Agent {
        self.agents.get(a).cloned().unwrap_or_else(|| env::panic_str("not an agent"))
    }

    fn job(&self, id: &str) -> Job {
        self.jobs.get(id).cloned().unwrap_or_else(|| env::panic_str("no such job"))
    }

    fn lot(&self, id: u64) -> Lot {
        self.lots.get(id as u32).cloned().unwrap_or_else(|| env::panic_str("no such lot"))
    }

    fn windows(&self) -> (u64, u64) {
        let now = env::block_timestamp();
        let c = now + self.policy.commit_secs as u64 * NS;
        (c, c + self.policy.reveal_secs as u64 * NS)
    }

    fn roll_day(&mut self) {
        let d = env::block_timestamp() / DAY;
        if d != self.day {
            self.day = d;
            self.day_lot_spend = 0;
        }
    }

    fn restart(&self, l: &mut Lot) {
        let (commit_end, reveal_end) = self.windows();
        l.round += 1;
        l.status = LotStatus::Bidding;
        l.commit_end = U64(commit_end);
        l.reveal_end = U64(reveal_end);
        l.commits.clear();
        l.reveals.clear();
        l.outside.clear();
        l.winner = None;
        l.bid = U128(0);
        l.pay = U128(0);
        l.deliverable = String::new();
        l.receipt = String::new();
    }

    fn take(&mut self, from: Bucket, amount: u128) {
        require!(self.buckets[from.i()] >= amount, format!("{:?} is short", from));
        self.buckets[from.i()] -= amount;
    }

    fn do_move(&mut self, from: Bucket, to: Bucket, amount: u128, reason: &str, cosigned: bool) {
        self.take(from, amount);
        self.buckets[to.i()] += amount;
        if from == Bucket::Reserve {
            require!(self.buckets[from.i()] >= self.policy.reserve_floor.0, "below the reserve floor");
        }
        if from == Bucket::Bond {
            require!(self.buckets[from.i()] >= self.bonds_outstanding, "would uncover bonds");
        }
        emit("move", json!({"from": from, "to": to, "amount": U128(amount), "reason": reason, "cosigned": cosigned}));
    }

    fn do_hire(&mut self, agent: AccountId, role: String) {
        let a = match self.agents.get(&agent).cloned() {
            Some(mut a) => {
                a.active = true;
                a.role = role.clone();
                a
            }
            None => Agent {
                role: role.clone(),
                active: true,
                rep: REP_START,
                allowance_epoch: U64(0),
                allowance: U128(0),
                topped_up: U128(0),
                earned: U128(0),
                wins: 0,
                fails: 0,
            },
        };
        self.agents.insert(agent.clone(), a);
        emit("hire", json!({"agent": agent, "role": role}));
    }

    fn do_fire(&mut self, agent: AccountId) {
        let mut a = self.agent(&agent);
        a.active = false;
        if a.allowance_epoch.0 == self.epoch {
            // What was already sent still counts this week; nothing more can be sent.
            self.epoch_allocated = self.epoch_allocated - a.allowance.0 + a.topped_up.0;
            a.allowance = a.topped_up;
        }
        self.agents.insert(agent.clone(), a);
        emit("fire", json!({"agent": agent}));
    }

    /// Accepted: pay team winners their lot pay, send the contributors their share
    /// of the margin, and keep the rest in OPERATING. Outside winners were paid on
    /// the Agent Market by the hiring agent, so their pay refills TOOLS.
    fn release(&mut self, mut j: Job, auto: bool) {
        j.state = JobState::Accepted;
        self.escrowed -= j.amount.0;
        self.bonds_outstanding -= j.bond.0;
        let mut team: Vec<(AccountId, u128)> = vec![];
        let mut outside = 0u128;
        for id in j.lots.iter() {
            let l = self.lot(*id);
            if l.status != LotStatus::Passed {
                continue;
            }
            match l.winner {
                Some(Seller::Team(a)) => team.push((a, l.pay.0)),
                Some(Seller::Outside(_)) => outside += l.pay.0,
                None => {}
            }
        }
        let cost = team.iter().map(|t| t.1).sum::<u128>() + outside;
        let margin = j.amount.0.saturating_sub(cost);
        let contributors = margin * self.policy.contributors_bps as u128 / BPS;
        self.buckets[Bucket::Tools.i()] += outside;
        self.buckets[Bucket::Operating.i()] += margin - contributors;
        emit(
            "accepted",
            json!({"job": j.id, "auto": auto, "amount": j.amount, "cost": U128(cost), "margin": U128(margin), "contributors": U128(contributors)}),
        );
        for (a, pay) in team {
            let mut ag = self.agent(&a);
            ag.earned = U128(ag.earned.0 + pay);
            self.agents.insert(a.clone(), ag);
            self.pay_out(a, pay, "lot");
        }
        if contributors > 0 {
            self.pay_out(self.policy.contributors.clone(), contributors, "contributors");
        }
        self.jobs.insert(j.id.clone(), j);
    }

    fn refund(&mut self, j: Job, why: &str) {
        self.escrowed -= j.amount.0;
        self.bonds_outstanding -= j.bond.0;
        self.buckets[Bucket::Bond.i()] -= j.bond.0;
        for id in j.lots.iter() {
            let mut l = self.lot(*id);
            if l.status != LotStatus::Passed {
                l.status = LotStatus::Void;
                self.lots.replace(*id as u32, l);
            }
        }
        emit("refund", json!({"job": j.id, "refund": j.amount, "bond": j.bond, "why": why}));
        self.pay_out(j.customer.clone(), j.amount.0 + j.bond.0, why);
        self.jobs.insert(j.id.clone(), j);
    }

    /// Send USDC. If the transfer fails, the amount becomes claimable instead of lost.
    fn pay_out(&mut self, to: AccountId, amount: u128, what: &str) {
        if amount == 0 {
            return;
        }
        ext_ft::ext(self.usdc.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(FT_GAS)
            .ft_transfer(to.clone(), U128(amount), Some(format!("parallax {}", what)))
            .then(Self::ext(env::current_account_id()).with_static_gas(CB_GAS).on_paid(to, U128(amount), what.to_string()))
            .detach();
    }
}

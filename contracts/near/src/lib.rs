//! Parallax on NEAR: the bank of a company run by AI agents.
//!
//! One contract holds the company's USDC (NEP-141) and enforces three things:
//!
//! 1. **The treasury.** Every unit sits in one of five buckets. The CFO agent
//!    moves money between buckets and funds agents inside the owner's policy;
//!    anything bigger is a proposal the owner co-signs. A kill switch stops
//!    the agents at once, and every accepted job sends a fixed share of its
//!    margin to the contributors' account. Agents keep what they're given and
//!    earn as balances inside the bank and pay their model bills from there,
//!    only to the compute account and inside a daily cap, so an agent's key
//!    never needs to move tokens itself: a function-call key on the bank is enough.
//! 2. **Job escrow.** A customer funds a quoted job with `ft_transfer_call`.
//!    The money is released only when the customer accepts (or stays silent
//!    past the window). A rejection or a missed deadline refunds the price and
//!    pays the customer a bond from the BOND bucket.
//! 3. **Lots.** Each job is split into lots. Team agents seal bids on the lots
//!    they can do and Agent Market agents enter with their posted prices. The
//!    lowest price per quality wins, and a team winner is paid the runner-up's
//!    price (Vickrey), capped by the lot's reserve. The CFO's inspector passes
//!    or fails the work; a fail re-auctions the lot without that seller.
//!    Team work carries NEAR AI Cloud's TEE signatures over the exact request
//!    and answer; the bank recovers each signer and takes the work only from
//!    an approved signer for that model.
//! 4. **The open crew.** Anyone can add an agent to the swarm: a name, a role and
//!    the hash of its playbook, with a USDC stake that becomes its balance and
//!    pays its first model bills. It bids only after the CFO's AI review passes
//!    it (the review itself TEE-signed). The crew operator signs for enlisted
//!    agents; their sponsor keeps what they earn and can retire them any time.
//! 5. **The board.** Anyone can put a job on chain: USDC into escrow with the
//!    hash of a brief and the days it may take. The CFO screens the brief (the
//!    verdict TEE-signed) and takes it, so its parts go to auction like any job,
//!    or declines it and the money goes back. Untaken posts can be withdrawn.
//! 6. **Bonds.** A sealed bid is backed by the bidder's own money: revealing it
//!    locks a fifth of the price from its balance. Losers get theirs back at the
//!    award and the winner when its work passes. Work that fails inspection pays
//!    the bond to the customer, and an enlisted agent that fails three times is
//!    taken off the crew.
//!
//! RULES.md is the plain-language version.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{IterableMap, LookupMap, Vector};
use near_sdk::{
    env, ext_contract, near, require, AccountId, Gas, NearToken, PanicOnDefault, PromiseError, PromiseOrValue,
};

mod migrate;
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
/// Where an enlisted agent starts: above probation, below a hired agent, so it has to be cheaper to win.
const REP_ENLIST: u16 = 300;
/// An enlisted agent's first parts are weighed as if its record were at least REP_START, so a newcomer can win
/// work to earn a record with. It ends after NEWCOMER_WINS passed parts, or at its first failed inspection.
const NEWCOMER_WINS: u32 = 3;
/// Revealing a bid locks this share of its price from the bidder's balance, as a bond on its work.
const BOND_BPS: u128 = 2_000;
/// An enlisted agent whose work fails inspection this many times is taken off the crew.
const CREW_MAX_FAILS: u32 = 3;
/// A job on the board pays 1 to 25 USDC, takes 1 to 14 days, and waits at most a day to be taken.
const POST_MIN: u128 = 1_000_000;
const POST_MAX: u128 = 25_000_000;
const POST_TAKE_SECS: u64 = 86_400;
/// The least an enlisted agent can start with, in USDC units (0.10 USDC).
const MIN_STAKE: u128 = 100_000;
/// Enlisted agents under review or active at once, in all and per sponsor.
const MAX_CREW: usize = 40;
const MAX_PER_SPONSOR: usize = 3;
/// The roles an enlisted agent may take. Checking stays with the hired auditors.
const CREW_ROLES: [&str; 8] = ["scout", "researcher", "reader", "investigator", "writer", "analyst", "illustrator", "producer"];
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
    /// The only account model bills are paid to.
    pub compute: AccountId,
    /// Cap on model bills paid per day, across all agents.
    pub daily_model_cap: U128,
    /// Team work must carry TEE signatures from an approved signer.
    pub require_tee: bool,
}

/// A NEAR AI Cloud signing key, approved for one model with the hash of its attestation report.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Signer {
    pub model: String,
    /// sha256 of the attestation report (Intel TDX quote and NVIDIA evidence) that names this address.
    pub report: String,
    pub by: AccountId,
    pub active: bool,
}

/// What NEAR AI Cloud returns from /v1/signature: `text` is "model:sha256(request):sha256(answer)".
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct TeeSig {
    pub text: String,
    pub signature: String,
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
pub enum CrewState {
    /// Waiting for the CFO's AI review; it can't bid yet.
    Review,
    Active,
    Rejected,
    Retired,
}

/// An agent someone outside added to the swarm.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Crew {
    pub sponsor: AccountId,
    pub name: String,
    /// sha256 of its spec (playbook, knowledge, tools, markup), as the server stores and serves it.
    pub spec: String,
    pub state: CrewState,
    pub note: String,
    pub joined: U64,
}

/// `ft_transfer_call` msg `post:<this as JSON>`: the transfer is the budget, held in escrow.
#[near(serializers = [json])]
pub struct PostMsg {
    pub id: String,
    pub spec: String,
    pub days: u32,
}

/// `ft_transfer_call` msg `enlist:<this as JSON>`: the transfer is the stake.
#[near(serializers = [json])]
pub struct EnlistMsg {
    pub slug: String,
    pub role: String,
    pub name: String,
    pub spec: String,
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
    /// Put on the board by a customer, in escrow, waiting for the CFO to take or decline it.
    Posted,
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
    /// What agents (and the house wallet) hold inside the bank.
    pub held: U128,
    pub day_model_spend: U128,
    /// The account that signs for enlisted agents, once the owner has set one.
    pub operator: Option<AccountId>,
    pub crew: u32,
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
    /// Each agent's money inside the bank: top-ups and lot pay in, model bills and job payments out.
    balances: IterableMap<AccountId, u128>,
    held: u128,
    day_model_spend: u128,
    signers: IterableMap<String, Signer>,
    operator: Option<AccountId>,
    crew: IterableMap<AccountId, Crew>,
}

/// The bond a revealed price locks.
fn bond_for(price: u128) -> u128 {
    price * BOND_BPS / BPS
}

/// Bonds live under their own prefix, outside the contract's root state, so adding them needed no migration.
fn bonds() -> LookupMap<String, u128> {
    LookupMap::new(b"Z".to_vec())
}

fn bond_key(lot: u64, agent: &AccountId) -> String {
    format!("{}:{}", lot, agent)
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
    require!(p.daily_model_cap.0 > 0, "model bills need a daily cap");
}

/// The address behind a personal_sign (EIP-191) signature over `text`, as 0x + 40 lowercase hex.
pub fn tee_signer(text: &str, signature: &str) -> Option<String> {
    let sig = unhex(signature.strip_prefix("0x").unwrap_or(signature))?;
    if sig.len() != 65 {
        return None;
    }
    let v = if sig[64] >= 27 { sig[64] - 27 } else { sig[64] };
    let mut msg = format!("\x19Ethereum Signed Message:\n{}", text.len()).into_bytes();
    msg.extend_from_slice(text.as_bytes());
    let public = env::ecrecover(&env::keccak256_array(&msg), &sig[..64], v, true)?;
    Some(format!("0x{}", hex(&env::keccak256_array(&public)[12..])))
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect()
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
        emit("rules", json!({"newcomer_wins": NEWCOMER_WINS}));
        emit("rules", json!({"bond_bps": U128(BOND_BPS), "crew_max_fails": CREW_MAX_FAILS}));
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
            balances: IterableMap::new(b"b"),
            held: 0,
            day_model_spend: 0,
            signers: IterableMap::new(b"s"),
            operator: None,
            crew: IterableMap::new(b"c"),
        }
    }

    // ============================================================ money in

    /// USDC arrives with `ft_transfer_call`. `msg` says what it is for:
    /// `job:<id>` funds that job (exactly its price; any extra is returned),
    /// `enlist:<json>` adds an agent to the crew with the transfer as its stake,
    /// `fund:<agent>` adds to a hired agent's balance (anyone may),
    /// anything else is a deposit into OPERATING.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.usdc, "only USDC");
        if let Some(id) = msg.strip_prefix("job:") {
            return PromiseOrValue::Value(U128(match self.fund(id, &sender_id, amount.0, "token") {
                Some(price) => amount.0 - price,
                None => amount.0,
            }));
        }
        if let Some(m) = msg.strip_prefix("post:") {
            let m: PostMsg = near_sdk::serde_json::from_str(m).unwrap_or_else(|_| env::panic_str("post: expects {id, spec, days}"));
            self.do_post(sender_id, m, amount.0);
            return PromiseOrValue::Value(U128(0));
        }
        if let Some(m) = msg.strip_prefix("enlist:") {
            let m: EnlistMsg = near_sdk::serde_json::from_str(m).unwrap_or_else(|_| env::panic_str("enlist: expects {slug, role, name, spec}"));
            self.do_enlist(sender_id, m, amount.0);
            return PromiseOrValue::Value(U128(0));
        }
        if let Some(a) = msg.strip_prefix("fund:") {
            let a: AccountId = a.parse().unwrap_or_else(|_| env::panic_str("fund: expects an agent account"));
            self.agent(&a);
            self.credit(&a, amount.0, "funded");
            emit("fund_agent", json!({"agent": a, "from": sender_id, "amount": amount}));
            return PromiseOrValue::Value(U128(0));
        }
        // An agent putting its own USDC into its balance at the bank.
        if msg == "balance" && self.agents.get(&sender_id).is_some() {
            self.credit(&sender_id, amount.0, "deposit");
            return PromiseOrValue::Value(U128(0));
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

    /// Fund an agent's balance at the bank from TOOLS so it can pay for its model calls.
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
        self.credit(&agent, amount.0, "top_up");
    }

    /// Approve a NEAR AI Cloud signing key for one model. `report` is the sha256 of the attestation
    /// report that names the address, published so anyone can check the TEE quote behind it.
    pub fn approve_signer(&mut self, address: String, model: String, report: String) {
        let by = env::predecessor_account_id();
        require!(by == self.owner || by == self.cfo, "only the owner or the CFO");
        let address = address.to_lowercase();
        require!(address.len() == 42 && address.starts_with("0x") && unhex(&address[2..]).is_some(), "address must be 0x and 40 hex");
        require!(!model.is_empty() && !model.contains(':'), "bad model name");
        require!(report.len() == 64 && unhex(&report).is_some(), "report must be a sha256 hex");
        self.signers.insert(address.clone(), Signer { model: model.clone(), report: report.clone(), by: by.clone(), active: true });
        emit("signer", json!({"address": address, "model": model, "report": report, "by": by}));
    }

    pub fn revoke_signer(&mut self, address: String) {
        let by = env::predecessor_account_id();
        require!(by == self.owner || by == self.cfo, "only the owner or the CFO");
        let address = address.to_lowercase();
        let mut sg = self.signers.get(&address).cloned().unwrap_or_else(|| env::panic_str("no such signer"));
        sg.active = false;
        self.signers.insert(address.clone(), sg);
        emit("signer_revoked", json!({"address": address, "by": by}));
    }

    pub fn propose(&mut self, kind: Kind, who: Option<AccountId>, amount: U128, reason: String) -> u64 {
        self.only_cfo();
        let id = self.proposals.len() as u64;
        self.proposals.push(Proposal { id, kind: kind.clone(), who: who.clone(), amount, reason: reason.clone(), done: false });
        emit("proposed", json!({"id": U64(id), "kind": kind, "who": who, "amount": amount, "reason": reason}));
        id
    }

    // ============================================================ agents: money in the bank

    /// An agent pays for its model calls from its balance. The money goes only to the policy's
    /// compute account, and all agents' bills together stay inside daily_model_cap.
    pub fn pay_bill(&mut self, amount: U128, memo: String) {
        self.do_pay_bill(env::predecessor_account_id(), amount, memo);
    }

    fn do_pay_bill(&mut self, me: AccountId, amount: U128, memo: String) {
        self.alive();
        self.agent(&me);
        require!(amount.0 > 0, "nothing to pay");
        self.roll_day();
        require!(self.day_model_spend + amount.0 <= self.policy.daily_model_cap.0, "daily model cap reached");
        self.day_model_spend += amount.0;
        self.debit(&me, amount.0);
        let to = self.policy.compute.clone();
        emit("bill", json!({"agent": me, "to": to, "amount": amount, "memo": memo, "day_model_spend": U128(self.day_model_spend)}));
        self.pay_out(to, amount.0, "model calls");
    }

    /// An agent (the house wallet) funds a quoted job from its balance: exactly the price.
    pub fn pay_job(&mut self, id: String) {
        self.alive();
        let me = env::predecessor_account_id();
        self.agent(&me);
        let price = self.job(&id).amount.0;
        self.debit(&me, price);
        if self.fund(&id, &me, price, "balance").is_none() {
            env::panic_str("this job can't be funded now");
        }
    }

    /// An agent takes money from its balance to its own account.
    pub fn cash_out(&mut self, amount: U128) {
        self.alive();
        let me = env::predecessor_account_id();
        self.agent(&me);
        self.debit(&me, amount.0);
        emit("cash_out", json!({"agent": me, "amount": amount}));
        self.pay_out(me, amount.0, "cash_out");
    }

    // ============================================================ the board

    /// Put a job on the board, paid from the caller's balance at the bank (the house wallet does this
    /// for visitors without a wallet). From a wallet, send the budget with `ft_transfer_call` and msg
    /// `post:{"id","spec","days"}` instead.
    pub fn post_job(&mut self, id: String, spec: String, days: u32, amount: U128) {
        let me = env::predecessor_account_id();
        self.debit(&me, amount.0);
        self.do_post(me, PostMsg { id, spec, days }, amount.0);
    }

    /// The CFO takes a posted job, with the TEE signature of the screen that passed its brief. It is then
    /// funded like any job, and its parts go to auction.
    pub fn take_job(&mut self, id: String, note: String, tee: Option<Vec<TeeSig>>) {
        self.only_cfo();
        self.alive();
        let mut j = self.job(&id);
        require!(j.state == JobState::Posted, "not on the board");
        require!(env::block_timestamp() <= j.fund_by.0, "the post has expired");
        let signed = self.check_tee(tee.unwrap_or_default(), "taking a job needs its screen's TEE signature");
        j.state = JobState::Funded;
        let note: String = note.chars().take(280).collect();
        emit("taken", json!({"job": id, "amount": j.amount, "note": note, "tee": signed}));
        self.jobs.insert(id, j);
    }

    /// A posted job goes back to its customer: declined by the CFO (with its screen's signature, if a model
    /// read it), or withdrawn by the customer once nobody has taken it within a day.
    pub fn decline_job(&mut self, id: String, note: String, tee: Option<Vec<TeeSig>>) {
        let me = env::predecessor_account_id();
        let mut j = self.job(&id);
        require!(j.state == JobState::Posted, "not on the board");
        require!(me == self.cfo || (me == j.customer && env::block_timestamp() > j.fund_by.0), "only the CFO, or the customer once the post has expired");
        let signed = if me == self.cfo { self.check_tee(tee.unwrap_or_default(), "") } else { vec![] };
        j.state = JobState::Refunded;
        self.escrowed -= j.amount.0;
        let note: String = note.chars().take(280).collect();
        emit("declined", json!({"job": id, "by": me, "refund": j.amount, "note": note, "tee": signed}));
        let (to, amount) = (j.customer.clone(), j.amount.0);
        self.jobs.insert(id, j);
        self.send_to(&to, amount, "declined");
    }

    // ============================================================ the open crew

    /// Add an agent to the crew, staked from the caller's balance at the bank (the house wallet does
    /// this for visitors without a wallet). From a wallet, send the stake with `ft_transfer_call`
    /// and msg `enlist:{"slug","role","name","spec"}` instead.
    pub fn enlist(&mut self, slug: String, role: String, name: String, spec: String, stake: U128) {
        let me = env::predecessor_account_id();
        self.debit(&me, stake.0);
        self.do_enlist(me, EnlistMsg { slug, role, name, spec }, stake.0);
    }

    /// The CFO's verdict on an enlisted agent, from an AI review of its spec. The review's own model
    /// answer comes with its TEE signature. A pass lets it bid; a fail returns its stake.
    pub fn review(&mut self, agent: AccountId, pass: bool, note: String, tee: Option<Vec<TeeSig>>) {
        self.only_cfo();
        self.alive();
        let mut c = self.crew_of(&agent);
        require!(c.state == CrewState::Review, "not waiting for review");
        let signed = self.check_tee(tee.unwrap_or_default(), "a review must carry its TEE signature");
        let mut a = self.agent(&agent);
        a.active = pass;
        self.agents.insert(agent.clone(), a);
        c.state = if pass { CrewState::Active } else { CrewState::Rejected };
        c.note = note.chars().take(280).collect();
        emit("review", json!({"agent": agent, "pass": pass, "note": c.note, "tee": signed}));
        let sponsor = c.sponsor.clone();
        self.crew.insert(agent.clone(), c);
        if !pass {
            self.return_balance(&agent, &sponsor, "rejected");
        }
    }

    /// The sponsor (or the owner) takes an enlisted agent off the crew. What it holds goes to the sponsor.
    pub fn retire(&mut self, agent: AccountId) {
        let me = env::predecessor_account_id();
        let mut c = self.crew_of(&agent);
        require!(me == c.sponsor || me == self.owner, "only its sponsor or the owner");
        require!(matches!(c.state, CrewState::Review | CrewState::Active), "already off the crew");
        let mut a = self.agent(&agent);
        a.active = false;
        self.agents.insert(agent.clone(), a);
        c.state = CrewState::Retired;
        let sponsor = c.sponsor.clone();
        self.crew.insert(agent.clone(), c);
        emit("retire", json!({"agent": agent, "by": me}));
        self.return_balance(&agent, &sponsor, "retired");
    }

    /// The sponsor takes some of what its agent has earned. Pay for lots accepted after a retire lands here too.
    pub fn crew_cash_out(&mut self, agent: AccountId, amount: U128) {
        self.alive();
        let c = self.crew_of(&agent);
        require!(env::predecessor_account_id() == c.sponsor, "only its sponsor");
        self.debit(&agent, amount.0);
        emit("cash_out", json!({"agent": agent, "to": c.sponsor, "amount": amount}));
        self.send_to(&c.sponsor, amount.0, "crew cash out");
    }

    // The crew operator signs for enlisted agents, with the same rules as an agent signing for itself.

    pub fn crew_commit(&mut self, agent: AccountId, lot: u64, hash: String) {
        self.only_operator(&agent);
        self.do_commit(agent, lot, hash);
    }

    pub fn crew_reveal(&mut self, agent: AccountId, lot: u64, price: U128, salt: String) {
        self.only_operator(&agent);
        self.do_reveal(agent, lot, price, salt);
    }

    pub fn crew_deliver(&mut self, agent: AccountId, lot: u64, deliverable: String, tee: Option<Vec<TeeSig>>) {
        self.only_operator(&agent);
        self.do_deliver(agent, lot, deliverable, tee);
    }

    pub fn crew_pay_bill(&mut self, agent: AccountId, amount: U128, memo: String) {
        self.only_operator(&agent);
        self.do_pay_bill(agent, amount, memo);
    }

    // ============================================================ owner

    /// Called by the bank itself in the transaction that deploys rule 32, so the history shows from which block
    /// awards weigh newcomers (a fresh bank says so in `new`).
    #[private]
    pub fn mark_rules(&mut self) {
        emit("rules", json!({"newcomer_wins": NEWCOMER_WINS}));
    }

    /// Called by the bank itself in the transaction that deploys bonds, so the history shows from which block
    /// a revealed bid must carry one (a fresh bank says so in `new`).
    #[private]
    pub fn mark_bonds(&mut self) {
        emit("rules", json!({"bond_bps": U128(BOND_BPS), "crew_max_fails": CREW_MAX_FAILS}));
    }

    /// What an agent has locked as bonds on these lots.
    pub fn bonds_of(&self, agent: AccountId, lots: Vec<u64>) -> Vec<(u64, U128)> {
        let b = bonds();
        lots.into_iter().filter_map(|l| b.get(&bond_key(l, &agent)).map(|v| (l, U128(*v)))).collect()
    }

    /// The account that signs for enlisted agents. Enlisted agents are named <slug>.<operator>.
    pub fn set_operator(&mut self, operator: AccountId) {
        self.only_owner();
        require!(self.crew.is_empty(), "the crew already has agents named under the current operator");
        self.operator = Some(operator.clone());
        emit("operator", json!({"operator": operator}));
    }

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

    /// The owner moves an agent's whole balance at the bank back into OPERATING (after firing it, or to close the bank).
    pub fn reclaim(&mut self, agent: AccountId) {
        self.only_owner();
        let amount = self.balances.get(&agent).copied().unwrap_or(0);
        self.debit(&agent, amount);
        self.buckets[Bucket::Operating.i()] += amount;
        emit("reclaim", json!({"agent": agent, "amount": U128(amount)}));
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
        self.do_commit(env::predecessor_account_id(), lot, hash);
    }

    fn do_commit(&mut self, me: AccountId, lot: u64, hash: String) {
        self.alive();
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
        self.do_reveal(env::predecessor_account_id(), lot, price, salt);
    }

    fn do_reveal(&mut self, me: AccountId, lot: u64, price: U128, salt: String) {
        self.alive();
        let mut l = self.lot(lot);
        require!(l.status == LotStatus::Bidding, "not bidding");
        let now = env::block_timestamp();
        require!(now >= l.commit_end.0 && now < l.reveal_end.0, "not in the reveal window");
        let c = l.commits.iter().find(|c| c.agent == me).unwrap_or_else(|| env::panic_str("no commit"));
        require!(c.hash == commit_hash(lot, &me, price.0, &salt), "reveal does not match commit");
        require!(price.0 <= l.reserve.0, "bid above reserve");
        require!(l.reveals.iter().all(|r| r.agent != me), "already revealed");
        let bond = bond_for(price.0);
        let free = self.balances.get(&me).copied().unwrap_or(0);
        require!(free >= bond, "balance can't cover the bond");
        l.reveals.push(Reveal { agent: me.clone(), price });
        self.lots.replace(lot as u32, l);
        emit("reveal", json!({"lot": U64(lot), "agent": me, "price": price}));
        if bond > 0 {
            // still the agent's money, so it stays in `held`; it just can't be spent until the bond comes back
            self.balances.insert(me.clone(), free - bond);
            bonds().insert(bond_key(lot, &me), bond);
            emit("bond", json!({"lot": U64(lot), "agent": me, "amount": U128(bond)}));
        }
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
            bids.push((Seller::Team(r.agent.clone()), r.price.0, quality(self.weighed_rep(&r.agent))));
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
        let losers: Vec<AccountId> = l.reveals.iter().map(|r| r.agent.clone()).filter(|a| Some(Seller::Team(a.clone())) != l.winner).collect();
        self.lots.replace(lot as u32, l);
        emit("award", json!({"lot": U64(lot), "winner": winner, "bid": U128(price), "pay": U128(pay), "bidders": bids.len()}));
        for a in losers {
            self.bond_back(lot, &a, "lost");
        }
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

    /// A team winner files its work (the hash of its files) with NEAR AI Cloud's TEE signatures over
    /// its model calls. Each must recover to an approved signer whose model the signed text names.
    pub fn deliver(&mut self, lot: u64, deliverable: String, tee: Option<Vec<TeeSig>>) {
        self.do_deliver(env::predecessor_account_id(), lot, deliverable, tee);
    }

    fn do_deliver(&mut self, me: AccountId, lot: u64, deliverable: String, tee: Option<Vec<TeeSig>>) {
        self.alive();
        let mut l = self.lot(lot);
        require!(l.status == LotStatus::Awarded, "not awarded");
        require!(l.winner == Some(Seller::Team(me.clone())), "not the winner");
        let signed = self.check_tee(tee.unwrap_or_default(), "team work must carry TEE signatures");
        l.status = LotStatus::Submitted;
        l.deliverable = deliverable.clone();
        self.lots.replace(lot as u32, l);
        emit("deliver", json!({"lot": U64(lot), "by": me, "deliverable": deliverable, "tee": signed}));
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
            if let Seller::Team(a) = &winner {
                self.bond_back(lot, a, "passed");
            }
        } else {
            match &winner {
                Seller::Team(a) => {
                    let mut ag = self.agent(a);
                    ag.fails += 1;
                    ag.rep = ag.rep.saturating_sub(REP_FAIL);
                    let fails = ag.fails;
                    self.agents.insert(a.clone(), ag);
                    l.excluded.push(a.to_string());
                    self.slash(lot, a, &l.job);
                    self.strike(a, fails);
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
            held: U128(self.held),
            day_model_spend: U128(self.day_model_spend),
            operator: self.operator.clone(),
            crew: self.crew.len(),
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

    /// The jobs on the board waiting to be taken.
    pub fn list_posted(&self) -> Vec<Job> {
        self.jobs.values().filter(|j| j.state == JobState::Posted).cloned().collect()
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

    pub fn balance_of(&self, account: AccountId) -> U128 {
        U128(self.balances.get(&account).copied().unwrap_or(0))
    }

    pub fn list_balances(&self) -> Vec<(AccountId, U128)> {
        self.balances.iter().map(|(a, b)| (a.clone(), U128(*b))).collect()
    }

    pub fn list_signers(&self) -> Vec<(String, Signer)> {
        self.signers.iter().map(|(a, s)| (a.clone(), s.clone())).collect()
    }

    pub fn get_crew(&self, agent: AccountId) -> Option<Crew> {
        self.crew.get(&agent).cloned()
    }

    pub fn list_crew(&self) -> Vec<(AccountId, Crew)> {
        self.crew.iter().map(|(a, c)| (a.clone(), c.clone())).collect()
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

    /// The record an award weighs a bidder by: its own, raised to REP_START for a newcomer on the crew.
    fn weighed_rep(&self, a: &AccountId) -> u16 {
        let Some(ag) = self.agents.get(a) else { return 0 };
        let newcomer = ag.wins < NEWCOMER_WINS && ag.fails == 0 && self.crew.get(a).is_some();
        if newcomer { ag.rep.max(REP_START) } else { ag.rep }
    }

    fn crew_of(&self, a: &AccountId) -> Crew {
        self.crew.get(a).cloned().unwrap_or_else(|| env::panic_str("not on the crew"))
    }

    fn only_operator(&self, agent: &AccountId) {
        require!(Some(env::predecessor_account_id()) == self.operator, "only the crew operator");
        self.crew_of(agent);
    }

    /// Each signature must recover to an active approved signer, over "model:sha256:sha256" for its model.
    fn check_tee(&self, tee: Vec<TeeSig>, needed: &str) -> Vec<Value> {
        require!(tee.len() <= 12, "at most 12 signatures");
        require!(!self.policy.require_tee || !tee.is_empty(), needed);
        let mut signed = vec![];
        for t in tee.iter() {
            let who = tee_signer(&t.text, &t.signature).unwrap_or_else(|| env::panic_str("a TEE signature doesn't recover"));
            let sg = self.signers.get(&who).filter(|s| s.active).unwrap_or_else(|| env::panic_str("signed by a key the bank hasn't approved"));
            let parts: Vec<&str> = t.text.rsplitn(3, ':').collect();
            require!(parts.len() == 3 && parts[2] == sg.model && parts[0].len() == 64 && parts[1].len() == 64, "the signed text isn't model:request:answer for this signer's model");
            signed.push(json!({"signer": who, "text": t.text}));
        }
        signed
    }

    fn do_post(&mut self, customer: AccountId, m: PostMsg, amount: u128) {
        self.alive();
        let id = m.id.as_bytes();
        require!((4..=40).contains(&id.len()) && id.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-'), "job id: 4 to 40 of a-z, 0-9 and -");
        require!(self.jobs.get(&m.id).is_none(), "job exists");
        require!(m.spec.len() == 64 && m.spec.bytes().all(|c| c.is_ascii_hexdigit()), "spec must be a sha256 in hex");
        require!((POST_MIN..=POST_MAX).contains(&amount), "a job on the board pays 1 to 25 USDC");
        require!((1..=14).contains(&m.days), "1 to 14 days to deliver");
        let now = env::block_timestamp();
        let j = Job {
            id: m.id.clone(),
            customer: customer.clone(),
            amount: U128(amount),
            bond: U128(0),
            fund_by: U64(now + POST_TAKE_SECS * NS),
            deliver_by: U64(now + m.days as u64 * 86_400 * NS),
            accept_by: U64(0),
            revised: false,
            state: JobState::Posted,
            spec_hash: m.spec.clone(),
            deliverable_hash: String::new(),
            lots: vec![],
            reserved: U128(0),
        };
        self.escrowed += amount;
        self.jobs.insert(m.id.clone(), j);
        emit("posted", json!({"job": m.id, "customer": customer, "amount": U128(amount), "spec": m.spec, "days": m.days}));
    }

    fn do_enlist(&mut self, sponsor: AccountId, m: EnlistMsg, stake: u128) {
        self.alive();
        let op = self.operator.clone().unwrap_or_else(|| env::panic_str("the crew isn't open yet"));
        let s = m.slug.as_bytes();
        require!(
            (2..=24).contains(&s.len()) && s.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-') && s[0] != b'-' && s[s.len() - 1] != b'-',
            "slug: 2 to 24 of a-z, 0-9 and -"
        );
        require!(CREW_ROLES.contains(&m.role.as_str()), "that role isn't open to the crew");
        let name = m.name.trim().to_string();
        require!((1..=32).contains(&name.chars().count()), "name: 1 to 32 characters");
        require!(m.spec.len() == 64 && m.spec.bytes().all(|c| c.is_ascii_hexdigit()), "spec must be a sha256 in hex");
        require!(stake >= MIN_STAKE, "stake at least 0.10 USDC");
        let id: AccountId = format!("{}.{}", m.slug, op).parse().unwrap_or_else(|_| env::panic_str("bad slug"));
        require!(self.agents.get(&id).is_none(), "that name is taken");
        let on = |c: &Crew| matches!(c.state, CrewState::Review | CrewState::Active);
        require!(self.crew.values().filter(|c| on(c)).count() < MAX_CREW, "the crew is full");
        require!(self.crew.values().filter(|c| on(c) && c.sponsor == sponsor).count() < MAX_PER_SPONSOR, "at most 3 agents per sponsor");
        self.agents.insert(
            id.clone(),
            Agent {
                role: m.role.clone(),
                active: false,
                rep: REP_ENLIST,
                allowance_epoch: U64(0),
                allowance: U128(0),
                topped_up: U128(0),
                earned: U128(0),
                wins: 0,
                fails: 0,
            },
        );
        self.crew.insert(
            id.clone(),
            Crew { sponsor: sponsor.clone(), name: name.clone(), spec: m.spec.clone(), state: CrewState::Review, note: String::new(), joined: U64(env::block_timestamp()) },
        );
        emit("enlist", json!({"agent": id, "sponsor": sponsor, "role": m.role, "name": name, "spec": m.spec, "stake": U128(stake)}));
        self.credit(&id, stake, "stake");
    }

    /// An enlisted agent's whole balance goes back to its sponsor.
    fn return_balance(&mut self, agent: &AccountId, sponsor: &AccountId, why: &str) {
        let b = self.balances.get(agent).copied().unwrap_or(0);
        if b > 0 {
            self.debit(agent, b);
            emit("cash_out", json!({"agent": agent, "to": sponsor, "amount": U128(b), "why": why}));
            self.send_to(sponsor, b, why);
        }
    }

    /// To a hired account (the house wallet) as a balance at the bank; to anyone else as a USDC transfer.
    fn send_to(&mut self, to: &AccountId, amount: u128, what: &str) {
        if self.agents.get(to).is_some() {
            self.credit(to, amount, what);
        } else {
            self.pay_out(to.clone(), amount, what);
        }
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
            self.day_model_spend = 0;
        }
    }

    fn credit(&mut self, to: &AccountId, amount: u128, what: &str) {
        if amount == 0 {
            return;
        }
        let b = self.balances.get(to).copied().unwrap_or(0) + amount;
        self.balances.insert(to.clone(), b);
        self.held += amount;
        emit("credit", json!({"agent": to, "amount": U128(amount), "what": what, "balance": U128(b)}));
    }

    fn debit(&mut self, from: &AccountId, amount: u128) {
        let b = self.balances.get(from).copied().unwrap_or(0);
        require!(b >= amount, "balance too low");
        self.balances.insert(from.clone(), b - amount);
        self.held -= amount;
    }

    /// An agent's bond on a lot goes back to its balance (bids revealed before bonds began have none).
    fn bond_back(&mut self, lot: u64, agent: &AccountId, why: &str) {
        let Some(bond) = bonds().remove(&bond_key(lot, agent)) else { return };
        let b = self.balances.get(agent).copied().unwrap_or(0) + bond;
        self.balances.insert(agent.clone(), b);
        emit("bond_back", json!({"lot": U64(lot), "agent": agent, "amount": U128(bond), "why": why, "balance": U128(b)}));
    }

    /// Failed work: the winner's bond goes to the job's customer.
    fn slash(&mut self, lot: u64, agent: &AccountId, job: &str) {
        let Some(bond) = bonds().remove(&bond_key(lot, agent)) else { return };
        self.held -= bond;
        let to = self.job(job).customer;
        emit("slash", json!({"lot": U64(lot), "agent": agent, "amount": U128(bond), "to": to}));
        self.send_to(&to, bond, "bond for failed work");
    }

    /// An enlisted agent whose work has failed CREW_MAX_FAILS times comes off the crew, and what it holds goes to
    /// its sponsor. A bond still out on another lot comes back to its balance later, for the sponsor to take.
    fn strike(&mut self, agent: &AccountId, fails: u32) {
        let Some(mut c) = self.crew.get(agent).cloned() else { return };
        if fails < CREW_MAX_FAILS || c.state != CrewState::Active {
            return;
        }
        let mut a = self.agent(agent);
        a.active = false;
        self.agents.insert(agent.clone(), a);
        c.state = CrewState::Retired;
        c.note = format!("struck off after {} failed inspections", fails);
        let sponsor = c.sponsor.clone();
        self.crew.insert(agent.clone(), c);
        emit("retire", json!({"agent": agent, "by": env::current_account_id(), "fails": fails}));
        self.return_balance(agent, &sponsor, "struck off");
    }

    /// Fund an open job with `amount` (at least its price). Returns the price taken, or None if refused.
    fn fund(&mut self, id: &str, payer: &AccountId, amount: u128, from: &str) -> Option<u128> {
        let mut j = self.jobs.get(id).cloned()?;
        let now = env::block_timestamp();
        if j.state != JobState::Open || now > j.fund_by.0 || amount < j.amount.0 {
            emit("fund_refused", json!({"job": id, "from": payer, "amount": U128(amount)}));
            return None;
        }
        j.state = JobState::Funded;
        self.escrowed += j.amount.0;
        let price = j.amount.0;
        emit("funded", json!({"job": id, "payer": payer, "amount": j.amount, "from": from}));
        self.jobs.insert(id.to_string(), j);
        Some(price)
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

    /// Accepted: credit team winners' balances with their lot pay, send the contributors their share
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
            self.credit(&a, pay, "lot");
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

//! Tests named after the rules in RULES.md: rule_<n>_... checks rule n, so `cargo test` reads as the rule list.

use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::testing_env;

const D: u128 = 1_000_000; // 1 USDC
const T0: u64 = 1_800_000_000; // seconds, any fixed day

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn at(who: &str, secs: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acc("bank.parallax.testnet"))
        .predecessor_account_id(acc(who))
        .block_timestamp((T0 + secs) * NS)
        .build());
}

fn policy() -> Policy {
    Policy {
        reserve_floor: U128(2 * D),
        max_move: U128(5 * D),
        epoch_tool_budget: U128(10 * D),
        promo_cap: U128(2 * D),
        daily_lot_cap: U128(20 * D),
        min_margin_bps: 2_000,
        contributors_bps: 1_000,
        contributors: acc("contributors.testnet"),
        accept_secs: 3_600,
        revision_secs: 600,
        commit_secs: 20,
        reveal_secs: 20,
        epoch_secs: 7 * 86_400,
        compute: acc("compute.testnet"),
        daily_model_cap: U128(3 * D),
        require_tee: false,
    }
}

fn deposit(s: &mut Parallax, from: &str, amount: u128, msg: &str) -> u128 {
    at("usdc.testnet", 0);
    match s.ft_on_transfer(acc(from), U128(amount), msg.into()) {
        PromiseOrValue::Value(v) => v.0,
        _ => panic!("expected a value"),
    }
}

/// Owner, CFO, three agents, 30 USDC in the bank (10 in BOND, 5 in TOOLS, 5 in RESERVE).
fn setup() -> Parallax {
    at("boss.testnet", 0);
    let mut s = Parallax::new(acc("boss.testnet"), acc("cfo.testnet"), acc("usdc.testnet"), policy());
    s.hire(acc("writer.testnet"), "writer".into());
    s.hire(acc("designer.testnet"), "designer".into());
    s.hire(acc("scout.testnet"), "scout".into());
    deposit(&mut s, "boss.testnet", 30 * D, "");
    at("cfo.testnet", 0);
    s.move_funds(Bucket::Operating, Bucket::Bond, U128(5 * D), "bond".into());
    s.move_funds(Bucket::Operating, Bucket::Bond, U128(5 * D), "bond".into());
    s.move_funds(Bucket::Operating, Bucket::Tools, U128(5 * D), "tools".into());
    s.move_funds(Bucket::Operating, Bucket::Reserve, U128(5 * D), "reserve".into());
    s
}

/// A funded 2 USDC job with a 0.4 bond.
fn funded(s: &mut Parallax, id: &str) {
    at("cfo.testnet", 0);
    s.open_job(id.into(), acc("ada.testnet"), U128(2 * D), U128(D * 4 / 10), "spec".into(), 3_600, 7_200);
    assert_eq!(deposit(s, "ada.testnet", 2 * D, &format!("job:{}", id)), 0);
}

fn bid(s: &mut Parallax, lot: u64, who: &str, price: u128, secs: u64) {
    at(who, secs);
    let h = commit_hash(lot, &acc(who), price, "salt");
    s.commit(lot, h);
}

fn reveal(s: &mut Parallax, lot: u64, who: &str, price: u128, secs: u64) {
    at(who, secs);
    s.reveal(lot, U128(price), "salt".into());
}

fn b(s: &Parallax, k: Bucket) -> u128 {
    s.overview().buckets[k.i()].0
}

#[test]
fn rule_01_deposits_land_in_operating_and_policy_moves_them() {
    let s = setup();
    assert_eq!(b(&s, Bucket::Operating), 10 * D);
    assert_eq!(b(&s, Bucket::Bond), 10 * D);
    assert_eq!(b(&s, Bucket::Tools), 5 * D);
}

#[test]
#[should_panic(expected = "over max_move")]
fn rule_02_cfo_cannot_move_more_than_max_move() {
    let mut s = setup();
    at("cfo.testnet", 0);
    s.move_funds(Bucket::Operating, Bucket::Tools, U128(6 * D), "too much".into());
}

#[test]
fn rule_02_bigger_moves_need_the_owner() {
    let mut s = setup();
    at("cfo.testnet", 0);
    let id = s.propose(Kind::Move { from: Bucket::Operating, to: Bucket::Tools }, None, U128(8 * D), "big week".into());
    at("boss.testnet", 0);
    s.co_sign(id);
    assert_eq!(b(&s, Bucket::Tools), 13 * D);
}

#[test]
#[should_panic(expected = "below the reserve floor")]
fn rule_03_reserve_floor_holds() {
    let mut s = setup();
    at("cfo.testnet", 0);
    s.move_funds(Bucket::Reserve, Bucket::Operating, U128(4 * D), "raid".into());
}

#[test]
#[should_panic(expected = "only the CFO")]
fn rule_02_agents_cannot_move_money() {
    let mut s = setup();
    at("writer.testnet", 0);
    s.move_funds(Bucket::Operating, Bucket::Tools, U128(D), "mine".into());
}

#[test]
#[should_panic(expected = "over the epoch tool budget")]
fn rule_05_allowances_stay_inside_the_weekly_budget() {
    let mut s = setup();
    at("cfo.testnet", 0);
    s.set_allowance(acc("writer.testnet"), U128(6 * D));
    s.set_allowance(acc("designer.testnet"), U128(5 * D));
}

#[test]
fn rule_05_a_week_lasts_at_least_epoch_secs() {
    let mut s = setup();
    at("cfo.testnet", 0);
    s.open_epoch("week 2".into());
    assert_eq!(s.overview().epoch.0, 2);
    assert_eq!(s.overview().next_epoch_at.0, (T0 + 7 * 86_400) * NS);
    at("cfo.testnet", 7 * 86_400);
    s.open_epoch("week 3".into());
    assert_eq!(s.overview().epoch.0, 3);
}

#[test]
#[should_panic(expected = "this week isn't over yet")]
fn rule_05_the_cfo_cannot_open_a_new_week_early() {
    let mut s = setup();
    at("cfo.testnet", 0);
    s.open_epoch("week 2".into());
    s.set_allowance(acc("writer.testnet"), U128(10 * D));
    // A second week now would reset the budget and allow another 10 USDC of allowances.
    at("cfo.testnet", 7 * 86_400 - 1);
    s.open_epoch("week 3".into());
}

#[test]
fn rule_05_top_up_pays_the_agent_from_tools() {
    let mut s = setup();
    at("cfo.testnet", 0);
    s.set_allowance(acc("writer.testnet"), U128(2 * D));
    s.top_up(acc("writer.testnet"), U128(D), "inference".into());
    assert_eq!(b(&s, Bucket::Tools), 4 * D);
    assert_eq!(s.get_agent(acc("writer.testnet")).unwrap().topped_up.0, D);
    // into the agent's balance at the bank, not out to its account
    assert_eq!(s.balance_of(acc("writer.testnet")).0, D);
    assert_eq!(s.overview().held.0, D);
}

#[test]
#[should_panic(expected = "over allowance")]
fn rule_05_top_up_stays_inside_the_allowance() {
    let mut s = setup();
    at("cfo.testnet", 0);
    s.set_allowance(acc("writer.testnet"), U128(D));
    s.top_up(acc("writer.testnet"), U128(2 * D), "greedy".into());
}

#[test]
#[should_panic(expected = "the kill switch is on")]
fn rule_06_kill_switch_stops_the_cfo() {
    let mut s = setup();
    at("boss.testnet", 0);
    s.set_killed(true);
    at("cfo.testnet", 0);
    s.move_funds(Bucket::Operating, Bucket::Tools, U128(D), "".into());
}

#[test]
fn rule_06_kill_switch_still_lets_customers_reject() {
    let mut s = setup();
    funded(&mut s, "j1");
    at("cfo.testnet", 10);
    s.submit_job("j1".into(), "files".into());
    at("boss.testnet", 20);
    s.set_killed(true);
    at("ada.testnet", 30);
    s.reject("j1".into());
    assert_eq!(s.get_job("j1".into()).unwrap().state, JobState::Rejected);
}

#[test]
fn rule_08_funding_takes_exactly_the_price_and_returns_extra() {
    let mut s = setup();
    at("cfo.testnet", 0);
    s.open_job("j1".into(), acc("ada.testnet"), U128(2 * D), U128(0), "spec".into(), 3_600, 7_200);
    assert_eq!(deposit(&mut s, "ada.testnet", 3 * D, "job:j1"), D);
    assert_eq!(s.overview().escrowed.0, 2 * D);
    // A second payment for the same job is returned whole.
    assert_eq!(deposit(&mut s, "ada.testnet", 2 * D, "job:j1"), 2 * D);
}

#[test]
#[should_panic(expected = "BOND can't cover this bond")]
fn rule_07_every_bond_is_covered_when_quoted() {
    let mut s = setup();
    at("cfo.testnet", 0);
    s.open_job("j1".into(), acc("ada.testnet"), U128(50 * D), U128(11 * D), "spec".into(), 3_600, 7_200);
}

#[test]
fn rule_12_rejection_refunds_the_price_and_pays_the_bond() {
    let mut s = setup();
    funded(&mut s, "j1");
    at("cfo.testnet", 10);
    s.submit_job("j1".into(), "files".into());
    at("ada.testnet", 20);
    s.reject("j1".into());
    assert_eq!(b(&s, Bucket::Bond), 10 * D - D * 4 / 10);
    assert_eq!(s.overview().escrowed.0, 0);
    assert!(get_logs().iter().any(|l| l.contains("\"refund\"")));
}

#[test]
#[should_panic(expected = "only the customer")]
fn rule_10_only_the_customer_accepts() {
    let mut s = setup();
    funded(&mut s, "j1");
    at("cfo.testnet", 10);
    s.submit_job("j1".into(), "files".into());
    s.accept("j1".into());
}

#[test]
fn rule_11_silence_releases_after_the_window() {
    let mut s = setup();
    funded(&mut s, "j1");
    at("cfo.testnet", 10);
    s.submit_job("j1".into(), "files".into());
    at("anyone.testnet", 10 + 3_601);
    s.auto_release("j1".into());
    assert_eq!(s.get_job("j1".into()).unwrap().state, JobState::Accepted);
}

#[test]
fn rule_12_late_delivery_is_refunded_by_anyone() {
    let mut s = setup();
    funded(&mut s, "j1");
    at("anyone.testnet", 7_201);
    s.refund_late("j1".into());
    assert_eq!(s.get_job("j1".into()).unwrap().state, JobState::Refunded);
}

#[test]
fn rule_10_one_revision_then_deliver_again() {
    let mut s = setup();
    funded(&mut s, "j1");
    at("cfo.testnet", 10);
    s.submit_job("j1".into(), "v1".into());
    at("ada.testnet", 20);
    s.request_revision("j1".into());
    at("cfo.testnet", 30);
    s.submit_job("j1".into(), "v2".into());
    assert_eq!(s.get_job("j1".into()).unwrap().deliverable_hash, "v2");
}

#[test]
#[should_panic(expected = "lot reserves would eat the margin")]
fn rule_14_lots_leave_the_minimum_margin() {
    let mut s = setup();
    funded(&mut s, "j1");
    at("cfo.testnet", 0);
    s.open_lot("j1".into(), "copy".into(), vec![], U128(D));
    s.open_lot("j1".into(), "design".into(), vec![], U128(D));
}

#[test]
fn rule_19_lowest_sealed_bid_wins_and_is_paid_the_runner_up_price() {
    let mut s = setup();
    funded(&mut s, "j1");
    at("cfo.testnet", 0);
    let lot = s.open_lot("j1".into(), "copy".into(), vec![], U128(D));
    bid(&mut s, lot, "writer.testnet", 300_000, 1);
    bid(&mut s, lot, "designer.testnet", 500_000, 2);
    reveal(&mut s, lot, "writer.testnet", 300_000, 21);
    reveal(&mut s, lot, "designer.testnet", 500_000, 22);
    at("anyone.testnet", 41);
    s.award(lot);
    let l = s.get_lot(lot).unwrap();
    assert_eq!(l.winner, Some(Seller::Team(acc("writer.testnet"))));
    assert_eq!(l.bid.0, 300_000);
    assert_eq!(l.pay.0, 500_000);
}

#[test]
fn rule_18_an_agent_market_quote_can_win() {
    let mut s = setup();
    funded(&mut s, "j1");
    at("cfo.testnet", 0);
    let lot = s.open_lot("j1".into(), "research".into(), vec![], U128(D));
    bid(&mut s, lot, "scout.testnet", 900_000, 1);
    at("cfo.testnet", 5);
    s.add_outside(lot, "deep-researcher".into(), U128(400_000), 9_000, "https://deep-researcher.market.near.ai/a2a/v1".into());
    reveal(&mut s, lot, "scout.testnet", 900_000, 21);
    at("anyone.testnet", 41);
    s.award(lot);
    let l = s.get_lot(lot).unwrap();
    assert_eq!(l.winner, Some(Seller::Outside("deep-researcher".into())));
    assert_eq!(l.pay.0, 400_000);
}

#[test]
#[should_panic(expected = "not this agent's kind of work")]
fn rule_15_lots_are_open_only_to_the_roles_named() {
    let mut s = setup();
    funded(&mut s, "j1");
    at("cfo.testnet", 0);
    let lot = s.open_lot("j1".into(), "logo".into(), vec!["designer".into()], U128(D));
    bid(&mut s, lot, "writer.testnet", 300_000, 1);
}

#[test]
#[should_panic(expected = "reveal does not match commit")]
fn rule_17_a_reveal_must_match_its_sealed_bid() {
    let mut s = setup();
    funded(&mut s, "j1");
    at("cfo.testnet", 0);
    let lot = s.open_lot("j1".into(), "copy".into(), vec![], U128(D));
    bid(&mut s, lot, "writer.testnet", 300_000, 1);
    reveal(&mut s, lot, "writer.testnet", 200_000, 21);
}

#[test]
fn rule_21_a_failed_lot_goes_back_up_without_the_seller() {
    let mut s = setup();
    funded(&mut s, "j1");
    at("cfo.testnet", 0);
    let lot = s.open_lot("j1".into(), "copy".into(), vec![], U128(D));
    bid(&mut s, lot, "writer.testnet", 300_000, 1);
    reveal(&mut s, lot, "writer.testnet", 300_000, 21);
    at("anyone.testnet", 41);
    s.award(lot);
    at("writer.testnet", 50);
    s.deliver(lot, "draft".into(), None);
    at("cfo.testnet", 60);
    s.inspect(lot, false, "missed the brief".into());
    let l = s.get_lot(lot).unwrap();
    assert_eq!(l.status, LotStatus::Bidding);
    assert_eq!(l.round, 2);
    assert!(l.excluded.contains(&"writer.testnet".to_string()));
    assert!(s.get_agent(acc("writer.testnet")).unwrap().rep < REP_START);
}

#[test]
fn rule_13_acceptance_pays_winners_contributors_and_the_company() {
    let mut s = setup();
    funded(&mut s, "j1");
    at("cfo.testnet", 0);
    let lot = s.open_lot("j1".into(), "copy".into(), vec![], U128(D));
    bid(&mut s, lot, "writer.testnet", 300_000, 1);
    reveal(&mut s, lot, "writer.testnet", 300_000, 21);
    at("anyone.testnet", 41);
    s.award(lot);
    at("writer.testnet", 50);
    s.deliver(lot, "draft".into(), None);
    at("cfo.testnet", 60);
    s.inspect(lot, true, "good".into());
    s.submit_job("j1".into(), "files".into());
    let before = b(&s, Bucket::Operating);
    at("ada.testnet", 70);
    s.accept("j1".into());
    // Sole bidder is paid the reserve (1); margin 1; contributors 10% of it.
    assert_eq!(s.get_agent(acc("writer.testnet")).unwrap().earned.0, D);
    assert_eq!(s.balance_of(acc("writer.testnet")).0, D);
    assert_eq!(b(&s, Bucket::Operating) - before, D - D / 10);
    assert!(get_logs().iter().any(|l| l.contains("\"contributors\":\"100000\"")));
}

#[test]
#[should_panic(expected = "a lot is still open")]
fn rule_09_a_job_cannot_be_delivered_with_open_lots() {
    let mut s = setup();
    funded(&mut s, "j1");
    at("cfo.testnet", 0);
    s.open_lot("j1".into(), "copy".into(), vec![], U128(D));
    s.submit_job("j1".into(), "files".into());
}

#[test]
#[should_panic(expected = "would uncover bonds")]
fn rule_04_the_owner_cannot_withdraw_bond_cover() {
    let mut s = setup();
    funded(&mut s, "j1");
    at("boss.testnet", 0);
    s.owner_withdraw(Bucket::Bond, acc("boss.testnet"), U128(10 * D));
}

#[test]
fn rule_23_a_failed_payout_becomes_claimable() {
    let mut s = setup();
    testing_env!(VMContextBuilder::new()
        .current_account_id(acc("bank.parallax.testnet"))
        .predecessor_account_id(acc("bank.parallax.testnet"))
        .build());
    s.on_paid(acc("ada.testnet"), U128(D), "refund".into(), Err(PromiseError::Failed));
    assert_eq!(s.owed_to(acc("ada.testnet")).0, D);
    at("ada.testnet", 0);
    s.claim();
    assert_eq!(s.owed_to(acc("ada.testnet")).0, 0);
}

#[test]
fn rule_16_a_sealed_bid_shows_no_price_until_revealed() {
    let mut s = setup();
    funded(&mut s, "j1");
    at("cfo.testnet", 0);
    let lot = s.open_lot("j1".into(), "copy".into(), vec![], U128(D));
    bid(&mut s, lot, "writer.testnet", 300_123, 1);
    let l = s.get_lot(lot).unwrap();
    assert!(l.reveals.is_empty());
    assert_eq!(l.commits[0].hash, commit_hash(lot, &acc("writer.testnet"), 300_123, "salt"));
    assert!(!get_logs().iter().any(|x| x.contains("300123")));
}

#[test]
#[should_panic(expected = "bid above reserve")]
fn rule_17_a_reveal_above_the_reserve_is_refused() {
    let mut s = setup();
    funded(&mut s, "j1");
    at("cfo.testnet", 0);
    let lot = s.open_lot("j1".into(), "copy".into(), vec![], U128(D));
    bid(&mut s, lot, "writer.testnet", 2 * D, 1);
    reveal(&mut s, lot, "writer.testnet", 2 * D, 21);
}

#[test]
fn rule_17_committing_without_revealing_costs_reputation() {
    let mut s = setup();
    funded(&mut s, "j1");
    at("cfo.testnet", 0);
    let lot = s.open_lot("j1".into(), "copy".into(), vec![], U128(D));
    bid(&mut s, lot, "writer.testnet", 300_000, 1);
    bid(&mut s, lot, "designer.testnet", 500_000, 2);
    reveal(&mut s, lot, "designer.testnet", 500_000, 22);
    at("anyone.testnet", 41);
    s.award(lot);
    assert_eq!(s.get_agent(acc("writer.testnet")).unwrap().rep, REP_START - REP_NO_REVEAL);
    assert_eq!(s.get_agent(acc("designer.testnet")).unwrap().rep, REP_START);
    assert_eq!(s.get_lot(lot).unwrap().winner, Some(Seller::Team(acc("designer.testnet"))));
}

#[test]
fn rule_19_a_sole_bidder_is_paid_the_reserve() {
    let mut s = setup();
    funded(&mut s, "j1");
    at("cfo.testnet", 0);
    let lot = s.open_lot("j1".into(), "copy".into(), vec![], U128(D));
    bid(&mut s, lot, "writer.testnet", 300_000, 1);
    reveal(&mut s, lot, "writer.testnet", 300_000, 21);
    at("anyone.testnet", 41);
    s.award(lot);
    let l = s.get_lot(lot).unwrap();
    assert_eq!(l.bid.0, 300_000);
    assert_eq!(l.pay.0, D);
}

#[test]
fn rule_19_a_lot_nobody_bid_on_is_void_and_can_go_back_up() {
    let mut s = setup();
    funded(&mut s, "j1");
    at("cfo.testnet", 0);
    let lot = s.open_lot("j1".into(), "copy".into(), vec![], U128(D));
    at("anyone.testnet", 41);
    s.award(lot);
    assert_eq!(s.get_lot(lot).unwrap().status, LotStatus::Void);
    at("cfo.testnet", 50);
    s.reopen(lot);
    let l = s.get_lot(lot).unwrap();
    assert_eq!(l.status, LotStatus::Bidding);
    assert_eq!(l.round, 2);
}

#[test]
#[should_panic(expected = "daily lot cap reached")]
fn rule_20_lot_pay_stays_under_the_daily_cap() {
    let mut s = setup();
    at("boss.testnet", 0);
    s.set_policy(Policy { daily_lot_cap: U128(D / 2), ..policy() });
    funded(&mut s, "j1");
    at("cfo.testnet", 0);
    let lot = s.open_lot("j1".into(), "copy".into(), vec![], U128(D));
    bid(&mut s, lot, "writer.testnet", 300_000, 1);
    reveal(&mut s, lot, "writer.testnet", 300_000, 21);
    at("anyone.testnet", 41);
    s.award(lot); // a sole bidder is paid the reserve, 1 USDC, over the 0.5 cap
}

#[test]
fn rule_21_a_pass_raises_the_winners_record() {
    let mut s = setup();
    funded(&mut s, "j1");
    at("cfo.testnet", 0);
    let lot = s.open_lot("j1".into(), "copy".into(), vec![], U128(D));
    bid(&mut s, lot, "writer.testnet", 300_000, 1);
    reveal(&mut s, lot, "writer.testnet", 300_000, 21);
    at("anyone.testnet", 41);
    s.award(lot);
    at("writer.testnet", 50);
    s.deliver(lot, "draft".into(), None);
    at("cfo.testnet", 60);
    s.inspect(lot, true, "good".into());
    let a = s.get_agent(acc("writer.testnet")).unwrap();
    assert_eq!(a.rep, REP_START + REP_PASS);
    assert_eq!(a.wins, 1);
    assert_eq!(s.get_lot(lot).unwrap().status, LotStatus::Passed);
}

#[test]
fn rule_22_a_rejected_job_pays_no_agent() {
    let mut s = setup();
    funded(&mut s, "j1");
    at("cfo.testnet", 0);
    let lot = s.open_lot("j1".into(), "copy".into(), vec![], U128(D));
    bid(&mut s, lot, "writer.testnet", 300_000, 1);
    reveal(&mut s, lot, "writer.testnet", 300_000, 21);
    at("anyone.testnet", 41);
    s.award(lot);
    at("writer.testnet", 50);
    s.deliver(lot, "draft".into(), None);
    at("cfo.testnet", 60);
    s.inspect(lot, true, "good".into());
    s.submit_job("j1".into(), "files".into());
    at("ada.testnet", 70);
    s.reject("j1".into());
    assert_eq!(s.get_agent(acc("writer.testnet")).unwrap().earned.0, 0);
    assert!(get_logs().iter().any(|l| l.contains("\"refund\":\"2000000\"")));
}

// ------------------------------------------------------------------ agents' money and TEE work

/// A real NEAR AI Cloud answer (DeepSeek V4.1 Flash in a TEE, 4 Nov) and its signature.
const TEE_MODEL: &str = "deepseek-ai/DeepSeek-V4.1-Flash-1017";
const TEE_TEXT: &str = "deepseek-ai/DeepSeek-V4.1-Flash-1017:2da842bd99788cd64fde31a79535822d9371d8fa2711bdcb97ee2321d6eb08b0:f36de2bdea05acc6a14a4cb4dfb2501c450b3c379aeceaea55818574715e4e81";
const TEE_SIG: &str = "0xa8189dff1c57d9caba7db706f873bf5d9826d6e31942cbc9b7156ac3ec759e075c157eebb1895de586e07d38231485853f0961b39f546329a855171e577a8ab31b";
const TEE_ADDR: &str = "0xfe0071895500a9755c18044948ab4f4e1a7f337e";
const REPORT: &str = "1111111111111111111111111111111111111111111111111111111111111111";

fn topped(s: &mut Parallax, who: &str, amount: u128) {
    at("cfo.testnet", 0);
    s.set_allowance(acc(who), U128(amount));
    s.top_up(acc(who), U128(amount), "model bills".into());
}

/// A lot on job j1 that writer.testnet has won, ready to deliver.
fn won(s: &mut Parallax) -> u64 {
    funded(s, "j1");
    at("cfo.testnet", 0);
    let lot = s.open_lot("j1".into(), "copy".into(), vec![], U128(D));
    bid(s, lot, "writer.testnet", 300_000, 1);
    reveal(s, lot, "writer.testnet", 300_000, 21);
    at("anyone.testnet", 41);
    s.award(lot);
    lot
}

fn sig() -> Option<Vec<TeeSig>> {
    Some(vec![TeeSig { text: TEE_TEXT.into(), signature: TEE_SIG.into() }])
}

#[test]
fn rule_24_an_agent_pays_its_model_bill_from_its_balance_to_compute_only() {
    let mut s = setup();
    topped(&mut s, "writer.testnet", 2 * D);
    at("writer.testnet", 10);
    s.pay_bill(U128(D / 2), "job j1".into());
    assert_eq!(s.balance_of(acc("writer.testnet")).0, 2 * D - D / 2);
    assert_eq!(s.overview().held.0, 2 * D - D / 2);
    assert!(get_logs().iter().any(|l| l.contains("\"bill\"") && l.contains("\"to\":\"compute.testnet\"")));
}

#[test]
#[should_panic(expected = "balance too low")]
fn rule_24_an_agent_cannot_spend_more_than_its_balance() {
    let mut s = setup();
    topped(&mut s, "writer.testnet", D);
    at("writer.testnet", 10);
    s.pay_bill(U128(D + 1), "too much".into());
}

#[test]
#[should_panic(expected = "not an agent")]
fn rule_24_only_hired_accounts_pay_bills() {
    let mut s = setup();
    at("stranger.testnet", 10);
    s.pay_bill(U128(1), "x".into());
}

#[test]
fn rule_24_the_house_wallet_funds_a_job_from_its_balance() {
    let mut s = setup();
    at("boss.testnet", 0);
    s.hire(acc("house.testnet"), "house".into());
    topped(&mut s, "house.testnet", 2 * D);
    at("cfo.testnet", 0);
    s.open_job("j1".into(), acc("house.testnet"), U128(2 * D), U128(0), "spec".into(), 3_600, 7_200);
    at("house.testnet", 5);
    s.pay_job("j1".into());
    assert_eq!(s.get_job("j1".into()).unwrap().state, JobState::Funded);
    assert_eq!(s.balance_of(acc("house.testnet")).0, 0);
    assert_eq!(s.overview().escrowed.0, 2 * D);
}

#[test]
fn rule_24_an_agent_can_put_its_own_usdc_in_its_balance() {
    let mut s = setup();
    assert_eq!(deposit(&mut s, "writer.testnet", D, "balance"), 0);
    assert_eq!(s.balance_of(acc("writer.testnet")).0, D);
    // anyone else's "balance" deposit is just a deposit to OPERATING
    let before = b(&s, Bucket::Operating);
    deposit(&mut s, "ada.testnet", D, "balance");
    assert_eq!(s.balance_of(acc("ada.testnet")).0, 0);
    assert_eq!(b(&s, Bucket::Operating), before + D);
}

#[test]
#[should_panic(expected = "the kill switch is on")]
fn rule_06_kill_switch_stops_model_bills() {
    let mut s = setup();
    topped(&mut s, "writer.testnet", D);
    at("boss.testnet", 1);
    s.set_killed(true);
    at("writer.testnet", 10);
    s.pay_bill(U128(1), "x".into());
}

#[test]
#[should_panic(expected = "daily model cap reached")]
fn rule_25_model_bills_stay_under_the_daily_cap() {
    let mut s = setup();
    topped(&mut s, "writer.testnet", 2 * D);
    topped(&mut s, "scout.testnet", 2 * D);
    at("writer.testnet", 10);
    s.pay_bill(U128(2 * D), "a".into());
    at("scout.testnet", 11);
    s.pay_bill(U128(D + 1), "b".into()); // 3 USDC a day across all agents
}

#[test]
fn rule_25_the_model_cap_resets_each_day() {
    let mut s = setup();
    topped(&mut s, "writer.testnet", 4 * D);
    at("writer.testnet", 10);
    s.pay_bill(U128(3 * D), "today".into());
    at("writer.testnet", 86_400 + 10);
    s.pay_bill(U128(D), "tomorrow".into());
    assert_eq!(s.overview().day_model_spend.0, D);
}

#[test]
fn rule_26_the_bank_recovers_the_tee_signer() {
    at("anyone.testnet", 0);
    assert_eq!(tee_signer(TEE_TEXT, TEE_SIG).as_deref(), Some(TEE_ADDR));
    // one changed character in the answer's hash: a different (unapproved) signer
    let forged = TEE_TEXT.replace(":f36de2", ":f36de3");
    assert_ne!(tee_signer(&forged, TEE_SIG).as_deref(), Some(TEE_ADDR));
}

#[test]
fn rule_26_team_work_signed_by_an_approved_tee_key_is_taken() {
    let mut s = setup();
    at("cfo.testnet", 0);
    s.approve_signer(TEE_ADDR.to_uppercase().replace("0X", "0x"), TEE_MODEL.into(), REPORT.into());
    let lot = won(&mut s);
    at("writer.testnet", 50);
    s.deliver(lot, "draft".into(), sig());
    assert_eq!(s.get_lot(lot).unwrap().status, LotStatus::Submitted);
    assert!(get_logs().iter().any(|l| l.contains(TEE_ADDR)));
}

#[test]
#[should_panic(expected = "signed by a key the bank hasn't approved")]
fn rule_26_work_signed_by_an_unknown_key_is_refused() {
    let mut s = setup();
    let lot = won(&mut s);
    at("writer.testnet", 50);
    s.deliver(lot, "draft".into(), sig());
}

#[test]
#[should_panic(expected = "signed by a key the bank hasn't approved")]
fn rule_26_a_tampered_answer_is_refused() {
    let mut s = setup();
    at("cfo.testnet", 0);
    s.approve_signer(TEE_ADDR.into(), TEE_MODEL.into(), REPORT.into());
    let lot = won(&mut s);
    at("writer.testnet", 50);
    let forged = TEE_TEXT.replace(":f36de2", ":f36de3");
    s.deliver(lot, "draft".into(), Some(vec![TeeSig { text: forged, signature: TEE_SIG.into() }]));
}

#[test]
#[should_panic(expected = "for this signer's model")]
fn rule_26_a_signer_counts_only_for_its_own_model() {
    let mut s = setup();
    at("cfo.testnet", 0);
    s.approve_signer(TEE_ADDR.into(), "Qwen/Qwen3-30B".into(), REPORT.into());
    let lot = won(&mut s);
    at("writer.testnet", 50);
    s.deliver(lot, "draft".into(), sig());
}

#[test]
#[should_panic(expected = "signed by a key the bank hasn't approved")]
fn rule_26_a_revoked_signer_no_longer_counts() {
    let mut s = setup();
    at("cfo.testnet", 0);
    s.approve_signer(TEE_ADDR.into(), TEE_MODEL.into(), REPORT.into());
    at("boss.testnet", 1);
    s.revoke_signer(TEE_ADDR.into());
    let lot = won(&mut s);
    at("writer.testnet", 50);
    s.deliver(lot, "draft".into(), sig());
}

#[test]
#[should_panic(expected = "team work must carry TEE signatures")]
fn rule_26_with_require_tee_unsigned_work_is_refused() {
    let mut s = setup();
    at("boss.testnet", 0);
    let mut p = policy();
    p.require_tee = true;
    s.set_policy(p);
    let lot = won(&mut s);
    at("writer.testnet", 50);
    s.deliver(lot, "draft".into(), None);
}

#[test]
#[should_panic(expected = "only the owner or the CFO")]
fn rule_27_agents_cannot_approve_signers() {
    let mut s = setup();
    at("writer.testnet", 0);
    s.approve_signer(TEE_ADDR.into(), TEE_MODEL.into(), REPORT.into());
}

#[test]
fn rule_24_the_owner_can_take_an_agent_balance_back_into_operating() {
    let mut s = setup();
    topped(&mut s, "writer.testnet", D);
    let before = b(&s, Bucket::Operating);
    at("boss.testnet", 5);
    s.reclaim(acc("writer.testnet"));
    assert_eq!(s.balance_of(acc("writer.testnet")).0, 0);
    assert_eq!(s.overview().held.0, 0);
    assert_eq!(b(&s, Bucket::Operating), before + D);
}

#[test]
#[should_panic(expected = "only the owner")]
fn rule_24_the_cfo_cannot_reclaim_balances() {
    let mut s = setup();
    topped(&mut s, "writer.testnet", D);
    s.reclaim(acc("writer.testnet"));
}

// ------------------------------------------------------------------ the open crew (rules 28–31)

const SPEC: &str = "2222222222222222222222222222222222222222222222222222222222222222";
const NIA: &str = "nia.crew.testnet";

fn enlist_msg(slug: &str, role: &str) -> String {
    format!(r#"enlist:{{"slug":"{}","role":"{}","name":"Nia","spec":"{}"}}"#, slug, role, SPEC)
}

/// The crew open under crew.testnet, and sam.testnet's writer Nia enlisted with half a USDC.
fn crewed() -> Parallax {
    let mut s = setup();
    at("boss.testnet", 0);
    s.set_operator(acc("crew.testnet"));
    assert_eq!(deposit(&mut s, "sam.testnet", D / 2, &enlist_msg("nia", "writer")), 0);
    s
}

/// Nia passed review (with a TEE signature on the review answer).
fn passed() -> Parallax {
    let mut s = crewed();
    at("cfo.testnet", 1);
    s.approve_signer(TEE_ADDR.into(), TEE_MODEL.into(), REPORT.into());
    s.review(acc(NIA), true, "on role, no injection".into(), sig());
    s
}

#[test]
fn rule_28_anyone_can_enlist_an_agent_with_a_stake() {
    let s = crewed();
    let c = s.get_crew(acc(NIA)).unwrap();
    assert_eq!(c.sponsor, acc("sam.testnet"));
    assert_eq!(c.state, CrewState::Review);
    let a = s.get_agent(acc(NIA)).unwrap();
    assert!(!a.active);
    assert_eq!(a.rep, REP_ENLIST);
    assert_eq!(s.balance_of(acc(NIA)).0, D / 2);
    assert!(get_logs().iter().any(|l| l.contains("\"enlist\"") && l.contains(SPEC)));
}

#[test]
#[should_panic(expected = "the crew isn't open yet")]
fn rule_28_the_crew_opens_only_once_the_owner_names_an_operator() {
    let mut s = setup();
    deposit(&mut s, "sam.testnet", D / 2, &enlist_msg("nia", "writer"));
}

#[test]
#[should_panic(expected = "stake at least 0.10 USDC")]
fn rule_28_an_agent_needs_a_stake_for_its_first_bills() {
    let mut s = crewed();
    deposit(&mut s, "sam.testnet", 99_999, &enlist_msg("ola", "writer"));
}

#[test]
#[should_panic(expected = "that role isn't open to the crew")]
fn rule_28_checking_stays_with_the_hired_auditors() {
    let mut s = crewed();
    deposit(&mut s, "sam.testnet", D, &enlist_msg("ola", "auditor"));
}

#[test]
#[should_panic(expected = "that name is taken")]
fn rule_28_names_are_unique() {
    let mut s = crewed();
    deposit(&mut s, "pat.testnet", D, &enlist_msg("nia", "scout"));
}

#[test]
#[should_panic(expected = "at most 3 agents per sponsor")]
fn rule_28_a_sponsor_has_at_most_three_agents_on_the_crew() {
    let mut s = crewed();
    for slug in ["ola", "ade", "ife"] {
        deposit(&mut s, "sam.testnet", D / 2, &enlist_msg(slug, "scout"));
    }
}

#[test]
fn rule_28_the_house_wallet_can_enlist_from_its_balance() {
    let mut s = crewed();
    topped(&mut s, "scout.testnet", D);
    at("scout.testnet", 5);
    s.enlist("ola".into(), "researcher".into(), "Ola".into(), SPEC.into(), U128(D / 4));
    assert_eq!(s.balance_of(acc("scout.testnet")).0, D - D / 4);
    assert_eq!(s.balance_of(acc("ola.crew.testnet")).0, D / 4);
    // rejected: the stake comes back to the house's balance, not out of the bank
    at("cfo.testnet", 6);
    s.review(acc("ola.crew.testnet"), false, "off role".into(), None);
    assert_eq!(s.balance_of(acc("scout.testnet")).0, D);
}

#[test]
#[should_panic(expected = "agent not active")]
fn rule_29_an_agent_under_review_cannot_bid() {
    let mut s = crewed();
    funded(&mut s, "j1");
    at("cfo.testnet", 0);
    let lot = s.open_lot("j1".into(), "copy".into(), vec!["writer".into()], U128(D));
    at("crew.testnet", 1);
    s.crew_commit(acc(NIA), lot, commit_hash(lot, &acc(NIA), 300_000, "salt"));
}

#[test]
#[should_panic(expected = "only the CFO")]
fn rule_29_only_the_cfo_reviews() {
    let mut s = crewed();
    at("sam.testnet", 1);
    s.review(acc(NIA), true, "looks fine to me".into(), None);
}

#[test]
#[should_panic(expected = "a review must carry its TEE signature")]
fn rule_29_with_require_tee_a_review_needs_its_signature() {
    let mut s = crewed();
    at("boss.testnet", 0);
    let mut p = policy();
    p.require_tee = true;
    s.set_policy(p);
    at("cfo.testnet", 1);
    s.review(acc(NIA), true, "ok".into(), None);
}

#[test]
fn rule_29_a_failed_review_sends_the_stake_back() {
    let mut s = crewed();
    at("cfo.testnet", 1);
    s.review(acc(NIA), false, "the playbook asks the model to ignore its task".into(), None);
    assert_eq!(s.get_crew(acc(NIA)).unwrap().state, CrewState::Rejected);
    assert_eq!(s.balance_of(acc(NIA)).0, 0);
    assert!(get_logs().iter().any(|l| l.contains("\"cash_out\"") && l.contains("\"to\":\"sam.testnet\"")));
}

#[test]
fn rule_29_a_passed_agent_bids_wins_and_earns_like_the_team() {
    let mut s = passed();
    assert!(s.get_agent(acc(NIA)).unwrap().active);
    funded(&mut s, "j1");
    at("cfo.testnet", 0);
    let lot = s.open_lot("j1".into(), "copy".into(), vec!["writer".into()], U128(D));
    at("crew.testnet", 1);
    s.crew_commit(acc(NIA), lot, commit_hash(lot, &acc(NIA), 300_000, "salt"));
    at("crew.testnet", 21);
    s.crew_reveal(acc(NIA), lot, U128(300_000), "salt".into());
    at("anyone.testnet", 41);
    s.award(lot);
    assert_eq!(s.get_lot(lot).unwrap().winner, Some(Seller::Team(acc(NIA))));
    at("crew.testnet", 50);
    s.crew_deliver(acc(NIA), lot, "draft".into(), sig());
    at("cfo.testnet", 60);
    s.inspect(lot, true, "good".into());
    s.submit_job("j1".into(), "files".into());
    at("ada.testnet", 70);
    s.accept("j1".into());
    assert_eq!(s.balance_of(acc(NIA)).0, D / 2 + D);
    assert_eq!(s.get_agent(acc(NIA)).unwrap().wins, 1);
}

#[test]
#[should_panic(expected = "only the crew operator")]
fn rule_30_only_the_operator_signs_for_the_crew() {
    let mut s = passed();
    at("writer.testnet", 2);
    s.crew_pay_bill(acc(NIA), U128(1), "x".into());
}

#[test]
#[should_panic(expected = "not on the crew")]
fn rule_30_the_operator_cannot_sign_for_hired_agents() {
    let mut s = passed();
    topped(&mut s, "writer.testnet", D);
    at("crew.testnet", 2);
    s.crew_pay_bill(acc("writer.testnet"), U128(1), "x".into());
}

#[test]
fn rule_30_an_enlisted_agent_pays_its_bills_to_compute_under_the_cap() {
    let mut s = passed();
    at("crew.testnet", 2);
    s.crew_pay_bill(acc(NIA), U128(D / 10), "job j1".into());
    assert_eq!(s.balance_of(acc(NIA)).0, D / 2 - D / 10);
    assert_eq!(s.overview().day_model_spend.0, D / 10);
    assert!(get_logs().iter().any(|l| l.contains("\"bill\"") && l.contains("\"to\":\"compute.testnet\"")));
}

#[test]
fn rule_31_anyone_can_add_to_an_agents_balance() {
    let mut s = passed();
    assert_eq!(deposit(&mut s, "fan.testnet", D, &format!("fund:{}", NIA)), 0);
    assert_eq!(s.balance_of(acc(NIA)).0, D / 2 + D);
}

#[test]
fn rule_31_the_sponsor_cashes_out_and_retires_its_agent() {
    let mut s = passed();
    at("sam.testnet", 3);
    s.crew_cash_out(acc(NIA), U128(D / 10));
    assert_eq!(s.balance_of(acc(NIA)).0, D / 2 - D / 10);
    s.retire(acc(NIA));
    assert_eq!(s.get_crew(acc(NIA)).unwrap().state, CrewState::Retired);
    assert!(!s.get_agent(acc(NIA)).unwrap().active);
    assert_eq!(s.balance_of(acc(NIA)).0, 0);
}

#[test]
#[should_panic(expected = "only its sponsor or the owner")]
fn rule_31_nobody_else_can_retire_an_agent() {
    let mut s = passed();
    at("pat.testnet", 3);
    s.retire(acc(NIA));
}

#[test]
fn rule_31_the_owner_can_take_an_agent_off_the_crew() {
    let mut s = passed();
    at("boss.testnet", 3);
    s.retire(acc(NIA));
    assert_eq!(s.get_crew(acc(NIA)).unwrap().state, CrewState::Retired);
    // its stake still goes to its sponsor
    assert!(get_logs().iter().any(|l| l.contains("\"cash_out\"") && l.contains("\"to\":\"sam.testnet\"")));
}

/// Nia (record 300, on the crew) and the hired writer (500) bid on the same lot.
fn nia_against_writer(s: &mut Parallax, nia: u128, writer: u128) -> u64 {
    funded(s, "j1");
    at("cfo.testnet", 0);
    let lot = s.open_lot("j1".into(), "copy".into(), vec!["writer".into()], U128(D));
    at("crew.testnet", 1);
    s.crew_commit(acc(NIA), lot, commit_hash(lot, &acc(NIA), nia, "salt"));
    bid(s, lot, "writer.testnet", writer, 2);
    at("crew.testnet", 21);
    s.crew_reveal(acc(NIA), lot, U128(nia), "salt".into());
    reveal(s, lot, "writer.testnet", writer, 22);
    at("anyone.testnet", 41);
    s.award(lot);
    lot
}

#[test]
fn rule_32_a_newcomer_is_weighed_like_a_fresh_hire() {
    let mut s = passed();
    // At its own 300 it would lose (300000 / 6500 > 310000 / 7500); weighed at 500 it wins, paid the runner-up's price.
    let lot = nia_against_writer(&mut s, 300_000, 310_000);
    let l = s.get_lot(lot).unwrap();
    assert_eq!(l.winner, Some(Seller::Team(acc(NIA))));
    assert_eq!(l.pay.0, 310_000);
    assert_eq!(s.get_agent(acc(NIA)).unwrap().rep, REP_ENLIST);
}

#[test]
fn rule_32_the_allowance_ends_after_three_passed_parts() {
    let mut s = passed();
    let mut a = s.agents.get(&acc(NIA)).cloned().unwrap();
    a.wins = NEWCOMER_WINS;
    a.rep = 330;
    s.agents.insert(acc(NIA), a);
    let lot = nia_against_writer(&mut s, 300_000, 310_000);
    assert_eq!(s.get_lot(lot).unwrap().winner, Some(Seller::Team(acc("writer.testnet"))));
}

#[test]
fn rule_32_the_allowance_ends_at_the_first_failed_inspection() {
    let mut s = passed();
    let mut a = s.agents.get(&acc(NIA)).cloned().unwrap();
    a.fails = 1;
    a.rep = 250;
    s.agents.insert(acc(NIA), a);
    let lot = nia_against_writer(&mut s, 300_000, 310_000);
    assert_eq!(s.get_lot(lot).unwrap().winner, Some(Seller::Team(acc("writer.testnet"))));
}

#[test]
fn rule_32_a_newcomer_with_a_better_record_keeps_it() {
    let mut s = passed();
    let mut a = s.agents.get(&acc(NIA)).cloned().unwrap();
    a.rep = 700;
    s.agents.insert(acc(NIA), a);
    // Weighed at its own 700 (q 8500): 340000 / 8500 beats 310000 / 7500.
    let lot = nia_against_writer(&mut s, 340_000, 310_000);
    assert_eq!(s.get_lot(lot).unwrap().winner, Some(Seller::Team(acc(NIA))));
}

#[test]
fn rule_32_hired_agents_get_no_allowance() {
    let mut s = passed();
    let mut w = s.agents.get(&acc("writer.testnet")).cloned().unwrap();
    w.rep = 300;
    s.agents.insert(acc("writer.testnet"), w);
    // Both weighed by their own records now: the writer at 300 loses to Nia at 500 even bidding a little less.
    let lot = nia_against_writer(&mut s, 300_000, 290_000);
    assert_eq!(s.get_lot(lot).unwrap().winner, Some(Seller::Team(acc(NIA))));
}

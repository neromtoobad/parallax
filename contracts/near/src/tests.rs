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
fn rule_05_top_up_pays_the_agent_from_tools() {
    let mut s = setup();
    at("cfo.testnet", 0);
    s.set_allowance(acc("writer.testnet"), U128(2 * D));
    s.top_up(acc("writer.testnet"), U128(D), "inference".into());
    assert_eq!(b(&s, Bucket::Tools), 4 * D);
    assert_eq!(s.get_agent(acc("writer.testnet")).unwrap().topped_up.0, D);
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
    s.deliver(lot, "draft".into());
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
    s.deliver(lot, "draft".into());
    at("cfo.testnet", 60);
    s.inspect(lot, true, "good".into());
    s.submit_job("j1".into(), "files".into());
    let before = b(&s, Bucket::Operating);
    at("ada.testnet", 70);
    s.accept("j1".into());
    // Sole bidder is paid the reserve (1); margin 1; contributors 10% of it.
    assert_eq!(s.get_agent(acc("writer.testnet")).unwrap().earned.0, D);
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
    s.deliver(lot, "draft".into());
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
    s.deliver(lot, "draft".into());
    at("cfo.testnet", 60);
    s.inspect(lot, true, "good".into());
    s.submit_job("j1".into(), "files".into());
    at("ada.testnet", 70);
    s.reject("j1".into());
    assert_eq!(s.get_agent(acc("writer.testnet")).unwrap().earned.0, 0);
    assert!(get_logs().iter().any(|l| l.contains("\"refund\":\"2000000\"")));
}

//! Test USDC for Parallax on NEAR testnet: a plain NEP-141 token with 6 decimals
//! and a faucet. `faucet()` gives the caller 20 USDC at most once an hour and
//! registers them on the token. It exists only so judges and customers can try
//! paying for a job without asking anyone for tokens. Never deploy it on mainnet.

use near_contract_standards::fungible_token::metadata::{FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC};
use near_contract_standards::fungible_token::{FungibleToken, FungibleTokenCore, FungibleTokenResolver};
use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds, StorageManagement};
use near_sdk::collections::LookupMap;
use near_sdk::json_types::U128;
use near_sdk::{env, log, near, require, AccountId, NearToken, PanicOnDefault, PromiseOrValue};

const DRIP: u128 = 20_000_000;
const HOUR_NS: u64 = 3_600_000_000_000;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct TestUsdc {
    token: FungibleToken,
    last_drip: LookupMap<AccountId, u64>,
}

#[near]
impl TestUsdc {
    #[init]
    pub fn new() -> Self {
        Self { token: FungibleToken::new(b"t".to_vec()), last_drip: LookupMap::new(b"d".to_vec()) }
    }

    /// 20 test USDC to the caller, once an hour.
    pub fn faucet(&mut self) -> U128 {
        let me = env::predecessor_account_id();
        let now = env::block_timestamp();
        let last = self.last_drip.get(&me).unwrap_or(0);
        require!(last == 0 || now - last >= HOUR_NS, "one drip an hour");
        self.last_drip.insert(&me, &now);
        if !self.token.accounts.contains_key(&me) {
            self.token.internal_register_account(&me);
        }
        self.token.internal_deposit(&me, DRIP);
        log!("EVENT_JSON:{{\"standard\":\"nep141\",\"version\":\"1.0.0\",\"event\":\"ft_mint\",\"data\":[{{\"owner_id\":\"{}\",\"amount\":\"{}\",\"memo\":\"faucet\"}}]}}", me, DRIP);
        U128(DRIP)
    }
}

#[near]
impl FungibleTokenCore for TestUsdc {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>, msg: String) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for TestUsdc {
    #[private]
    fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        let (used, _burned) = self.token.internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        used.into()
    }
}

#[near]
impl StorageManagement for TestUsdc {
    #[payable]
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.token.internal_storage_unregister(force).is_some()
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for TestUsdc {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Parallax test USDC".to_string(),
            symbol: "USDC".to_string(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 6,
        }
    }
}

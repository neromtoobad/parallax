#!/usr/bin/env bash
# Closes a Parallax deployment and sends what it holds back to the root account: every bucket's USDC, every
# account's USDC, and the NEAR the accounts were created with, the bank's ~3.3 NEAR of code storage included.
# Run it after judging. It refuses while customers have money in escrow or the bank owes anyone.
#
#   NET=mainnet ROOT=useparallax.near PLAN_ONLY=1 ./teardown.sh   what it would do, sending nothing
#   NET=mainnet ROOT=useparallax.near ./teardown.sh                do it (add SIGN=ledger for the root)
#
# NEAR won't delete an account that stores more than 10 KB, so the bank's code is first replaced with
# contracts/near-cleanup (680 bytes), which clears the bank's storage; then the account is deleted.
# The CFO is left as it is: deploy.sh took away its full-access key, so only its gas allowance stays there.
set -euo pipefail
cd "$(dirname "$0")"
NET=${NET:-testnet}
case "$NET" in
  testnet) ROOT=${ROOT:-parallax.testnet}; RPC=${NEAR_RPC:-https://test.rpc.fastnear.com} ;;
  mainnet) ROOT=${ROOT:?set ROOT, e.g. ROOT=useparallax.near}; RPC=${NEAR_RPC:-https://free.rpc.fastnear.com} ;;
  *) echo "NET must be testnet or mainnet" >&2; exit 1 ;;
esac
NETCFG="network-config $NET"
case "${SIGN:-keychain}" in ledger) ROOT_SIGN=sign-with-ledger ;; *) ROOT_SIGN=sign-with-legacy-keychain ;; esac
KEYS=~/.near-credentials/$NET
DEP=../../deployments/near-$NET.json
[ -f "$DEP" ] || { echo "no $DEP" >&2; exit 1; }
j() { python3 -c "import json,sys;d=json.load(open('$DEP'));print(d$1)"; }
BANK=$(j "['bank']"); USDC=$(j "['usdc']"); CFO=$(j "['cfo']")
[ "$(j "['owner']")" = "$ROOT" ] || { echo "$DEP belongs to $(j "['owner']"), not $ROOT" >&2; exit 1; }
TEAM=team.$ROOT

q() { curl -s "$RPC" -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":$1}"; }
view() { # view <contract> <method> <json>
  q "{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$1\",\"method_name\":\"$2\",\"args_base64\":\"$(printf '%s' "$3" | base64)\"}" |
    python3 -c "import json,sys;r=json.load(sys.stdin).get('result');print(bytes(r['result']).decode() if r else 'null')"
}
near_of() { q "{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}" |
  python3 -c "import json,sys;r=json.load(sys.stdin).get('result');print(round(int(r['amount'])/1e24,4) if r else '-')"; }
usdc_of() { view "$USDC" ft_balance_of "{\"account_id\":\"$1\"}" | python3 -c "import json,sys;v=json.load(sys.stdin);print(int(v or 0))"; }
signer() { [ "$1" = "$ROOT" ] && echo "$ROOT_SIGN" || echo sign-with-legacy-keychain; }
retry() { for i in 1 2 3 4; do "$@" && return 0; echo "  retry $i: ${*:1:5}" >&2; sleep 3; done; return 1; }
call() { # call <contract> <method> <json> <signer> [deposit]
  retry near contract call-function as-transaction "$1" "$2" json-args "$3" prepaid-gas '100.0 Tgas' \
    attached-deposit "${5:-0 NEAR}" sign-as "$4" $NETCFG "$(signer "$4")" send >/dev/null
}
gone() { [ "$(near_of "$1")" = "-" ]; }
close() { # close <account>: its USDC to the root, its USDC registration refunded, then the account deleted
  local a=$1 u
  gone "$a" && { echo "· $a already closed"; return; }
  [ -f "$KEYS/$a.json" ] || { echo "· $a: no key in $KEYS, left as it is"; return; }
  u=$(usdc_of "$a")
  [ "$u" -gt 0 ] && call "$USDC" ft_transfer "{\"receiver_id\":\"$ROOT\",\"amount\":\"$u\"}" "$a" '1 yoctoNEAR'
  call "$USDC" storage_unregister '{"force":false}' "$a" '1 yoctoNEAR' 2>/dev/null || true
  retry near account delete-account "$a" beneficiary "$ROOT" $NETCFG sign-with-legacy-keychain send >/dev/null
  echo "- $a closed ($(python3 -c "print($u/1e6)") USDC back)"
}

# Everyone below team.$ROOT, from the keychain, plus the other accounts deploy.sh made.
AGENTS=($(ls "$KEYS" 2>/dev/null | sed -n "s/^\(.*\.$TEAM\)\.json$/\1/p"))
OTHERS=($(j "['house']" 2>/dev/null || true) $(j "['contributors']") $(j "['compute']"))
OV=$(view "$BANK" overview '{}')
read -r ESCROW BONDS OWED BUCKETS <<<"$(python3 -c "
import json;o=json.loads('''$OV''');print(o['escrowed'],o['bonds_outstanding'],o['owed'],','.join(o['buckets']))")"

echo "Teardown plan for $ROOT on $NET:"
echo "  bank $BANK: $(near_of "$BANK") NEAR; buckets (Operating, Tools, Bond, Reserve, Promo) $BUCKETS (USDC units)"
echo "  escrowed $ESCROW, bonds outstanding $BONDS, owed $OWED"
for a in "${OTHERS[@]}" "${AGENTS[@]}" "$TEAM"; do echo "  $a: $(near_of "$a") NEAR, $(python3 -c "print($(usdc_of "$a")/1e6)") USDC"; done
echo "  $CFO: $(near_of "$CFO") NEAR, stays (function-call key only)"
echo "Everything above goes to $ROOT; the bank is stopped first and its code is replaced, so this can't be undone."
[ "$ESCROW" = 0 ] && [ "$BONDS" = 0 ] && [ "$OWED" = 0 ] || { echo "customers still have money in the bank: settle or refund those jobs first" >&2; exit 1; }
[ "${PLAN_ONLY:-}" = 1 ] && exit 0
read -r -p "Type $ROOT to close this deployment: " typed
[ "$typed" = "$ROOT" ] || { echo "not confirmed; nothing sent"; exit 1; }

# 1. Stop the CFO and the agents, and take every bucket out to the root.
if ! gone "$BANK"; then
  call "$BANK" set_killed '{"killed":true}' "$ROOT"
  i=0
  for b in Operating Tools Bond Reserve Promo; do
    amt=$(echo "$BUCKETS" | cut -d, -f$((i + 1))); i=$((i + 1))
    [ "$amt" != 0 ] && call "$BANK" owner_withdraw "{\"from\":\"$b\",\"to\":\"$ROOT\",\"amount\":\"$amt\"}" "$ROOT" && echo "  $b: $(python3 -c "print($amt/1e6)") USDC to $ROOT"
  done
fi

# 2. The agents, the house wallet, contributors and compute, then their parent.
for a in "${AGENTS[@]}" "${OTHERS[@]}"; do close "$a"; done
close "$TEAM"

# 3. The bank: swap in the cleanup code, clear its storage, delete it.
if ! gone "$BANK"; then
  [ -f "$KEYS/$BANK.json" ] || { echo "no key for $BANK in $KEYS: it stays" >&2; exit 1; }
  call "$USDC" storage_unregister '{"force":false}' "$BANK" '1 yoctoNEAR' 2>/dev/null || true
  (cd ../near-cleanup && cargo build --target wasm32-unknown-unknown --release -q)
  near contract deploy "$BANK" use-file ../near-cleanup/target/wasm32-unknown-unknown/release/parallax_cleanup.wasm \
    without-init-call $NETCFG sign-with-legacy-keychain send >/dev/null
  echo "  the bank's code is replaced"
  ARGS=$(mktemp)
  q "{\"request_type\":\"view_state\",\"finality\":\"final\",\"account_id\":\"$BANK\",\"prefix_base64\":\"\"}" | python3 -c "
import base64,json,struct,sys
keys=[base64.b64decode(v['key']) for v in json.load(sys.stdin)['result']['values']]
open('$ARGS','wb').write(b''.join(struct.pack('<I',len(k))+k for k in keys))
print(f'  clearing {len(keys)} storage keys')"
  retry near contract call-function as-transaction "$BANK" clean file-args "$ARGS" prepaid-gas '300.0 Tgas' \
    attached-deposit '0 NEAR' sign-as "$BANK" $NETCFG sign-with-legacy-keychain send >/dev/null
  rm -f "$ARGS"
  retry near account delete-account "$BANK" beneficiary "$ROOT" $NETCFG sign-with-legacy-keychain send >/dev/null
  echo "- $BANK closed"
fi
echo "done: $ROOT now holds $(near_of "$ROOT") NEAR and $(python3 -c "print($(usdc_of "$ROOT")/1e6)") USDC"

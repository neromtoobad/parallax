#!/usr/bin/env bash
# Sets up Parallax on NEAR (testnet or mainnet) from one funded root account. Keys land in
# ~/.near-credentials/<net>, never in this repo.
#
#   usdc.$ROOT          testnet only: test USDC with a faucet (contracts/near-usdc). Mainnet uses Circle's USDC.
#   bank.$ROOT          the parallax contract: treasury, escrow, lots
#   cfo.$ROOT           the CFO, left with a function-call key on the bank only
#   contributors.$ROOT  receives the contributors' share of every margin
#   compute.$ROOT       receives what the agents pay for their model calls
#   team.$ROOT          parent of one account per agent: <role>.team.$ROOT
#
#   ./deploy.sh                                       testnet, root parallax.testnet
#   NET=mainnet ROOT=parallax.near PLAN_ONLY=1 ./deploy.sh   print what mainnet would do and cost, send nothing
#   NET=mainnet ROOT=parallax.near SIGN=ledger ./deploy.sh   deploy on mainnet, the root signing on a Ledger
#
# The policy is policy-<net>.json. Mainnet asks you to type the root account before anything is sent,
# and writes deployments/near-mainnet.json at the end. Re-running skips accounts that already exist.
# Run server/scripts/mainnet-preflight.ts first. Needs near-cli-rs and cargo-near.
set -euo pipefail
cd "$(dirname "$0")"
NET=${NET:-testnet}
case "$NET" in
  testnet) ROOT=${ROOT:-parallax.testnet}; RPC=${NEAR_RPC:-https://near-testnet.drpc.org}; USDC=${USDC:-usdc.$ROOT} ;;
  mainnet) ROOT=${ROOT:?set ROOT, e.g. ROOT=parallax.near}; RPC=${NEAR_RPC:-https://free.rpc.fastnear.com}
           USDC=17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1 ;; # Circle's native USDC on NEAR
  *) echo "NET must be testnet or mainnet" >&2; exit 1 ;;
esac
NETCFG="network-config $NET"
# Only the root's own signatures can move to a Ledger; the accounts made here sign from the keychain.
case "${SIGN:-keychain}" in ledger) ROOT_SIGN=sign-with-ledger ;; *) ROOT_SIGN=sign-with-legacy-keychain ;; esac
KEYS=~/.near-credentials/$NET
ROLES=(scout researcher writer illustrator reader analyst messenger auditor producer investigator)
# A second agent for these roles, so their lots have more than one bidder: <role>-2.team.$ROOT
SECOND_ROLES=(researcher writer illustrator auditor)
BANK=bank.$ROOT
CFO=cfo.$ROOT
TEAM=team.$ROOT
CONTRIB=contributors.$ROOT
COMPUTE=compute.$ROOT
AGENTS=("${ROLES[@]/%/.$TEAM}" "${SECOND_ROLES[@]/%/-2.$TEAM}")
# NEAR each new account starts with: the bank's covers its code (~330 KB) and state; an agent's pays its bid gas.
# Override with FUND_BANK, FUND_CFO, FUND_SMALL, FUND_AGENT and FUND_USDC (testnet root from the faucet has 10 NEAR).
FUND_BANK=${FUND_BANK:-4.5} FUND_CFO=${FUND_CFO:-0.5} FUND_SMALL=${FUND_SMALL:-0.1} FUND_AGENT=${FUND_AGENT:-0.15}
# team.$ROOT pays for the agents it creates, so it starts with their NEAR plus its own
FUND_TEAM=$(python3 -c "print(round(${#AGENTS[@]}*$FUND_AGENT+0.2,2))")

q() { curl -s "$RPC" -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":$1}"; }
exists() { # asks the RPC directly; near-cli's view can fail on a busy node and look like "missing"
  for i in 1 2 3; do
    r=$(q "{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}")
    case "$r" in *'"amount"'*) return 0;; *UNKNOWN_ACCOUNT*) return 1;; esac
    sleep 2
  done
  return 1
}
# The token's minimum storage deposit, in NEAR (0.00125 for both tokens at the time of writing).
STORAGE=$(q "{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$USDC\",\"method_name\":\"storage_balance_bounds\",\"args_base64\":\"e30=\"}" |
  python3 -c "import json,sys;r=json.load(sys.stdin).get('result');print(int(json.loads(bytes(r['result']))['min'])/1e24 if r else 0.00125)" 2>/dev/null || echo 0.00125)

if [ "$NET" = mainnet ]; then
  COST=$(python3 -c "print(round($FUND_BANK+$FUND_CFO+2*$FUND_SMALL+$FUND_TEAM+(${#AGENTS[@]}+5)*$STORAGE+0.3,2))")
  cat <<PLAN
Mainnet plan for $ROOT (policy-mainnet.json, USDC $USDC):
  create  $BANK ($FUND_BANK NEAR), $CFO ($FUND_CFO), $CONTRIB, $COMPUTE ($FUND_SMALL each), $TEAM ($FUND_TEAM)
          ${#AGENTS[@]} agents under $TEAM ($FUND_AGENT NEAR each, paid by $TEAM)
  deploy  the bank contract to $BANK, owner $ROOT, CFO $CFO
  register ${#AGENTS[@]}+5 accounts on USDC ($STORAGE NEAR each), hire ${#AGENTS[@]} agents
  key     leave $CFO with a function-call key on $BANK only
About $COST NEAR from $ROOT, including ~0.3 NEAR of gas. Nothing is sent in USDC.
PLAN
  [ "${PLAN_ONLY:-}" = 1 ] && exit 0
  read -r -p "Type $ROOT to deploy on mainnet: " typed
  [ "$typed" = "$ROOT" ] || { echo "not confirmed; nothing sent"; exit 1; }
fi

sub() { # sub <account> <parent> <NEAR>
  if exists "$1"; then echo "· $1 exists"; return; fi
  local sign=sign-with-legacy-keychain
  [ "$2" = "$ROOT" ] && sign=$ROOT_SIGN
  near account create-account fund-myself "$1" "$3 NEAR" autogenerate-new-keypair save-to-legacy-keychain \
    sign-as "$2" $NETCFG $sign send >/dev/null
  echo "+ $1"
}
retry() { for i in 1 2 3 4; do "$@" && return 0; echo "  retry $i: ${*:1:5}" >&2; sleep 3; done; return 1; }
call() { retry call1 "$@"; }
call1() { # call <contract> <method> <json> <signer> [deposit]
  local sign=sign-with-legacy-keychain
  [ "$4" = "$ROOT" ] && sign=$ROOT_SIGN
  near contract call-function as-transaction "$1" "$2" json-args "$3" prepaid-gas '100.0 Tgas' \
    attached-deposit "${5:-0 NEAR}" sign-as "$4" $NETCFG $sign send >/dev/null
}

(cd ../near && cargo near build non-reproducible-wasm >/dev/null)

if [ "$NET" = testnet ] && [ "$USDC" = "usdc.$ROOT" ] && ! exists "$USDC"; then
  (cd ../near-usdc && cargo near build non-reproducible-wasm >/dev/null)
  sub "$USDC" "$ROOT" ${FUND_USDC:-2}
  near contract deploy "$USDC" use-file ../near-usdc/target/near/parallax_test_usdc.wasm \
    with-init-call new json-args '{}' prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' \
    $NETCFG sign-with-legacy-keychain send >/dev/null
  echo "  deployed test USDC"
fi

sub "$CFO" "$ROOT" $FUND_CFO
sub "$CONTRIB" "$ROOT" $FUND_SMALL
sub "$COMPUTE" "$ROOT" $FUND_SMALL
sub "$TEAM" "$ROOT" $FUND_TEAM
for a in "${AGENTS[@]}"; do sub "$a" "$TEAM" $FUND_AGENT; done

if ! exists "$BANK"; then
  sub "$BANK" "$ROOT" $FUND_BANK
  INIT=$(python3 -c "import json;p=json.load(open('policy-$NET.json'));p['contributors']='$CONTRIB';print(json.dumps({'owner':'$ROOT','cfo':'$CFO','usdc':'$USDC','policy':p}))")
  near contract deploy "$BANK" use-file target/near/parallax_near.wasm \
    with-init-call new json-args "$INIT" prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' \
    $NETCFG sign-with-legacy-keychain send >/dev/null
  echo "  deployed the bank"
fi

# Everyone who receives USDC must be registered on the token.
for a in "$BANK" "$CONTRIB" "$COMPUTE" "$CFO" "$ROOT" "${AGENTS[@]}"; do
  call "$USDC" storage_deposit "{\"account_id\":\"$a\",\"registration_only\":true}" "$ROOT" "$STORAGE NEAR"
done
echo "  registered on $USDC"

for r in "${ROLES[@]}"; do call "$BANK" hire "{\"agent\":\"$r.$TEAM\",\"role\":\"$r\"}" "$ROOT"; done
for r in "${SECOND_ROLES[@]}"; do call "$BANK" hire "{\"agent\":\"$r-2.$TEAM\",\"role\":\"$r\"}" "$ROOT"; done
echo "  hired ${#AGENTS[@]} agents"

# The CFO keeps only a function-call key on the bank: it can't send money anywhere.
if [ -f "$KEYS/$CFO.json" ] && ! [ -f "$KEYS/$CFO.bank-key.json" ]; then
  FULL=$(python3 -c "import json;print(json.load(open('$KEYS/$CFO.json'))['public_key'])")
  near account add-key "$CFO" grant-function-call-access --allowance '0.45 NEAR' --contract-account-id "$BANK" \
    --function-names '' autogenerate-new-keypair save-to-legacy-keychain $NETCFG sign-with-legacy-keychain send >/dev/null
  NEW=$(ls -t "$KEYS/$CFO"/*.json | head -1)
  cp "$NEW" "$KEYS/$CFO.bank-key.json"
  near account delete-keys "$CFO" public-keys "$FULL" $NETCFG sign-with-legacy-keychain send >/dev/null
  echo "  $CFO now has only a function-call key on $BANK"
fi

# The server reads the deployment from deployments/near-<net>.json. An existing file is left alone.
OUT=../../deployments/near-$NET.json
if ! [ -f "$OUT" ]; then
  python3 - "$OUT" <<PY
import json, sys
mainnet = "$NET" == "mainnet"
team = {r: f"{r}.$TEAM" for r in "${ROLES[*]}".split()}  # one account per role; the bank lists the second agents
json.dump({
  "network": "$NET", "rpc": "$RPC",
  "rpcFallbacks": ["https://rpc.mainnet.near.org"] if mainnet else ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"],
  "explorer": "https://nearblocks.io" if mainnet else "https://testnet.nearblocks.io",
  "owner": "$ROOT", "bank": "$BANK", "usdc": "$USDC", "usdcFaucet": not mainnet,
  "cfo": "$CFO", "contributors": "$CONTRIB", "team": team, "compute": "$COMPUTE",
}, open(sys.argv[1], "w"), indent=2)
open(sys.argv[1], "a").write("\n")
PY
  echo "  wrote deployments/near-$NET.json"
fi

echo "done on $NET: bank $BANK, usdc $USDC, cfo $CFO, ${#AGENTS[@]} agents under $TEAM"

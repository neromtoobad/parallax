#!/usr/bin/env bash
# Sets up Parallax on NEAR (testnet or mainnet) from one funded root account. Keys land in
# ~/.near-credentials/<net>, never in this repo.
#
#   usdc.$ROOT          testnet only: test USDC with a faucet (contracts/near-usdc). Mainnet uses Circle's USDC.
#   bank.$ROOT          the parallax contract: treasury, escrow, lots
#   cfo.$ROOT           the CFO, left with a function-call key on the bank only (so are the agents and the house)
#   contributors.$ROOT  receives the contributors' share of every margin
#   compute.$ROOT       receives what the agents pay for their model calls
#   team.$ROOT          parent of one account per agent: <role>.team.$ROOT
#   house.$ROOT         the house wallet that pays for demo jobs, hired so the CFO can top it up
#   crew.$ROOT          the crew operator: signs for agents the public enlists (<slug>.crew.$ROOT, no keys of their own)
#
#   ./deploy.sh                                       testnet, root parallax.testnet
#   NET=mainnet ROOT=parallax.near PLAN_ONLY=1 ./deploy.sh   print what mainnet would do and cost, send nothing
#   NET=mainnet ROOT=parallax.near SIGN=ledger ROOT_PK=ed25519:… ./deploy.sh   deploy on mainnet, the root signing on a Ledger
#   UPGRADE=1 ./deploy.sh                             testnet: put the new contract on the 4 Nov bank and open the crew
#
# Every account that signs on the server (CFO, agents, house, crew operator) ends with one function-call key that can only call the
# bank, and none of their calls attach a deposit. Each agent's and the house's full access moves to the root's own
# public key (ROOT_PK, read from the keychain when the root signs there), so only the owner can ever empty them.
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
HOUSE=house.$ROOT
CREW=crew.$ROOT
AGENTS=("${ROLES[@]/%/.$TEAM}" "${SECOND_ROLES[@]/%/-2.$TEAM}")
# NEAR each new account starts with: the bank's covers its code (~380 KB, 3.8 NEAR) and state. A signer must also
# hold its call's whole prepaid gas up front (~0.001 NEAR per Tgas, mostly refunded): agents bid at 12 Tgas, the CFO
# calls at 30, the house wallet pays at 80 and accepts at 150. Mainnet starts lean; teardown.sh gets most of it back.
# The crew operator signs every enlisted agent's bids (12 Tgas), deliveries and bills (40).
# Override with FUND_BANK, FUND_CFO, FUND_SMALL, FUND_AGENT, FUND_HOUSE, FUND_CREW and FUND_USDC (testnet root from the faucet has 10 NEAR).
if [ "$NET" = mainnet ]; then
  FUND_BANK=${FUND_BANK:-4.6} FUND_CFO=${FUND_CFO:-0.1} FUND_SMALL=${FUND_SMALL:-0.01} FUND_AGENT=${FUND_AGENT:-0.03} FUND_HOUSE=${FUND_HOUSE:-0.18} FUND_CREW=${FUND_CREW:-0.06}
else
  FUND_BANK=${FUND_BANK:-4.9} FUND_CFO=${FUND_CFO:-0.5} FUND_SMALL=${FUND_SMALL:-0.1} FUND_AGENT=${FUND_AGENT:-0.15} FUND_HOUSE=${FUND_HOUSE:-0.25} FUND_CREW=${FUND_CREW:-0.3}
fi
# team.$ROOT pays for the agents it creates, so it starts with their NEAR, ~0.008 a creation for gas, plus its own
FUND_TEAM=$(python3 -c "print(round(${#AGENTS[@]}*($FUND_AGENT+0.008)+0.02,3))")

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
  COST=$(python3 -c "print(round($FUND_BANK+$FUND_CFO+2*$FUND_SMALL+$FUND_HOUSE+$FUND_CREW+$FUND_TEAM+(${#AGENTS[@]}+6)*$STORAGE+0.1,2))")
  cat <<PLAN
Mainnet plan for $ROOT (policy-mainnet.json, USDC $USDC):
  create  $BANK ($FUND_BANK NEAR), $CFO ($FUND_CFO), $CONTRIB, $COMPUTE ($FUND_SMALL each), $HOUSE ($FUND_HOUSE), $CREW ($FUND_CREW), $TEAM ($FUND_TEAM)
          ${#AGENTS[@]} agents under $TEAM ($FUND_AGENT NEAR each, paid by $TEAM)
  deploy  the bank contract to $BANK, owner $ROOT, CFO $CFO, crew operator $CREW
  register ${#AGENTS[@]}+6 accounts on USDC ($STORAGE NEAR each), hire ${#AGENTS[@]} agents and the house wallet
  key     leave $CFO, the agents, $HOUSE and $CREW with function-call keys on $BANK only; their full access goes to $ROOT's key
About $COST NEAR from $ROOT, including ~0.1 NEAR of gas. Nothing is sent in USDC.
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
retry() { for i in 1 2 3 4 5; do "$@" && return 0; echo "  retry $i: ${*:1:5}" >&2; sleep $((5 * i)); done; return 1; }
viewj() { # viewj <contract> <method> <json>: the JSON result, or null
  q "{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$1\",\"method_name\":\"$2\",\"args_base64\":\"$(printf '%s' "$3" | base64)\"}" |
    python3 -c "import json,sys;r=json.load(sys.stdin).get('result');print(bytes(r['result']).decode() if r else 'null')"
}
call() { retry call1 "$@"; }
call1() { # call <contract> <method> <json> <signer> [deposit]   GAS=<Tgas> for a lighter call
  local sign=sign-with-legacy-keychain
  [ "$4" = "$ROOT" ] && sign=$ROOT_SIGN
  near contract call-function as-transaction "$1" "$2" json-args "$3" prepaid-gas "${GAS:-100}.0 Tgas" \
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
sub "$HOUSE" "$ROOT" $FUND_HOUSE
sub "$CREW" "$ROOT" $FUND_CREW
sub "$TEAM" "$ROOT" $FUND_TEAM
for a in "${AGENTS[@]}"; do sub "$a" "$TEAM" $FUND_AGENT; done

if ! exists "$BANK"; then
  sub "$BANK" "$ROOT" $FUND_BANK
  INIT=$(python3 -c "import json;p=json.load(open('policy-$NET.json'));p['contributors']='$CONTRIB';p['compute']='$COMPUTE';print(json.dumps({'owner':'$ROOT','cfo':'$CFO','usdc':'$USDC','policy':p}))")
  near contract deploy "$BANK" use-file target/near/parallax_near.wasm \
    with-init-call new json-args "$INIT" prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' \
    $NETCFG sign-with-legacy-keychain send >/dev/null
  echo "  deployed the bank"
elif [ "${UPGRADE:-}" = 1 ]; then
  [ "$NET" = testnet ] || { echo "UPGRADE is for the testnet bank; a mainnet bank deploys fresh" >&2; exit 1; }
  # Already upgraded (a re-run): the bank's overview names a crew operator.
  if [ "$(viewj "$BANK" overview '{}' | python3 -c "import json,sys;print('operator' in json.load(sys.stdin))")" = False ]; then
    near contract deploy "$BANK" use-file target/near/parallax_near.wasm \
      with-init-call migrate json-args "{\"operator\":\"$CREW\"}" prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' \
      $NETCFG sign-with-legacy-keychain send >/dev/null
    echo "  upgraded the bank and opened the crew under $CREW"
  fi
  # What agents and the house hold in their own accounts goes into their balance at the bank, while they still have full keys.
  for a in "${AGENTS[@]}" "$HOUSE"; do
    [ -f "$KEYS/$a.bank-key.json" ] && continue
    HAVE=$(q "{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$USDC\",\"method_name\":\"ft_balance_of\",\"args_base64\":\"$(printf '{"account_id":"%s"}' "$a" | base64)\"}" |
      python3 -c "import json,sys;r=json.load(sys.stdin)['result'];print(json.loads(bytes(r['result'])))")
    if [ "$HAVE" != 0 ]; then
      # 60 Tgas: an agent may hold under 0.1 NEAR, and a call holds its whole prepaid gas up front
      GAS=60 call "$USDC" ft_transfer_call "{\"receiver_id\":\"$BANK\",\"amount\":\"$HAVE\",\"msg\":\"balance\"}" "$a" "1 yoctoNEAR"
      echo "  $a: $HAVE units into its balance at the bank"
    fi
  done
fi

# The crew opens once the bank knows its operator (a fresh bank; an upgraded one names it in migrate).
if [ "$(viewj "$BANK" overview '{}' | python3 -c "import json,sys;print(json.load(sys.stdin).get('operator'))")" = None ]; then
  call "$BANK" set_operator "{\"operator\":\"$CREW\"}" "$ROOT"
  echo "  the crew operator is $CREW"
fi

# Everyone who receives USDC must be registered on the token.
for a in "$BANK" "$CONTRIB" "$COMPUTE" "$CFO" "$ROOT" "$HOUSE" "${AGENTS[@]}"; do
  [ "$(viewj "$USDC" storage_balance_of "{\"account_id\":\"$a\"}")" != null ] && continue
  call "$USDC" storage_deposit "{\"account_id\":\"$a\",\"registration_only\":true}" "$ROOT" "$STORAGE NEAR"
done
echo "  registered on $USDC"

hire() { [ "$(viewj "$BANK" get_agent "{\"account\":\"$1\"}")" != null ] || call "$BANK" hire "{\"agent\":\"$1\",\"role\":\"$2\"}" "$ROOT"; }
for r in "${ROLES[@]}"; do hire "$r.$TEAM" "$r"; done
for r in "${SECOND_ROLES[@]}"; do hire "$r-2.$TEAM" "$r"; done
hire "$HOUSE" house
echo "  hired ${#AGENTS[@]} agents and the house wallet"

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

# The agents, the house and the crew operator the same way: a function-call key on the bank (no allowance cap: they pay their own gas),
# and their full access handed to the root's key, so the server never holds a key that can move their NEAR or tokens.
ROOT_PK=${ROOT_PK:-$(python3 -c "import json;print(json.load(open('$KEYS/$ROOT.json'))['public_key'])" 2>/dev/null || true)}
[ -n "$ROOT_PK" ] || { echo "set ROOT_PK to $ROOT's public key (ed25519:…)" >&2; exit 1; }
keys_of() { # the account's keys as "public_key permission" lines (permission: full or fc)
  q "{\"request_type\":\"view_access_key_list\",\"finality\":\"final\",\"account_id\":\"$1\"}" |
    python3 -c "import json,sys;[print(k['public_key'],'full' if k['access_key']['permission']=='FullAccess' else 'fc') for k in json.load(sys.stdin)['result']['keys']]"
}
for a in "${AGENTS[@]}" "$HOUSE" "$CREW"; do
  # each step checks the chain first, so a run cut short (a rate-limited RPC, say) picks up where it stopped
  if ! [ -f "$KEYS/$a.bank-key.json" ]; then
    retry near account add-key "$a" grant-function-call-access --allowance unlimited --contract-account-id "$BANK" \
      --function-names '' autogenerate-new-keypair save-to-legacy-keychain $NETCFG sign-with-legacy-keychain send >/dev/null
    NEW=$(ls -t "$KEYS/$a"/*.json | head -1)
    cp "$NEW" "$KEYS/$a.bank-key.json"
  fi
  KL=$(keys_of "$a")
  grep -q "^$ROOT_PK full" <<<"$KL" ||
    retry near account add-key "$a" grant-full-access use-manually-provided-public-key "$ROOT_PK" $NETCFG sign-with-legacy-keychain send >/dev/null
  for k in $(grep " full$" <<<"$KL" | cut -d' ' -f1 | grep -v "^$ROOT_PK$" || true); do
    KF="$KEYS/$a/${k/:/_}.json"; [ -f "$KF" ] || KF="$KEYS/$a.json" # the file holding that key (a cut-short run can leave a stale $a.json)
    retry near account delete-keys "$a" public-keys "$k" $NETCFG sign-with-access-key-file "$KF" send >/dev/null
  done
  echo "  $a: a function-call key on $BANK; full access is $ROOT's key"
  sleep 5 # public RPCs rate-limit near-cli
done

# The server reads the deployment from deployments/near-<net>.json. An existing file is left alone.
OUT=${OUT:-../../deployments/near-$NET.json}
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
  "cfo": "$CFO", "contributors": "$CONTRIB", "team": team, "compute": "$COMPUTE", "house": "$HOUSE", "crew": "$CREW",
}, open(sys.argv[1], "w"), indent=2)
open(sys.argv[1], "a").write("\n")
PY
  echo "  wrote $OUT"
fi

echo "done on $NET: bank $BANK, usdc $USDC, cfo $CFO, ${#AGENTS[@]} agents under $TEAM"

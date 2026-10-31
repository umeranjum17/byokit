#!/bin/sh
# The failover plan's appendix B inner script, with the kit starting the binary (run.ts) instead of a hand-written config.
# Runs inside `unshare -rn`: the only network is this namespace's loopback.
set -eu
WORK=$1; BIN=$2; FX=$3
umask 077
: > "$WORK/hits.jsonl"
ip link set lo up
HITLOG="$WORK/hits.jsonl" PORT=18911 FAIL_FIRST=1 FAIL_STATUS=503 node "$FX/fake-upstream.mjs" & UP=$!
trap 'kill $UP 2>/dev/null || true' EXIT
code=$(node "$FX/run.ts" "$WORK/state" "$BIN")
hits=$(wc -l < "$WORK/hits.jsonl"); ids=$(sed 's/.*"authId":"\([^"]*\)".*/\1/' "$WORK/hits.jsonl" | sort -u | wc -l)
seq=$(sed 's/.*"status":\([0-9]*\).*/\1/' "$WORK/hits.jsonl" | tr '\n' ' ')
leak=$(grep -rl 'fixture-upstream-key-1' "$WORK" | grep -v '/hits.jsonl$' | wc -l)
logs=$(find "$WORK" -name '*.log' -not -name server.log | wc -l)
disguised=$(grep -c '"disguised":true' "$WORK/hits.jsonl" || true)
echo "client_http=$code upstream_hits=$hits statuses=[$seq] distinct_upstream_identities=$ids leak_files=$leak extra_log_files=$logs disguised_calls=$disguised"
[ "$code" = 200 ] && [ "$hits" = 2 ] && [ "$seq" = "503 200 " ] && [ "$ids" = 1 ] && [ "$leak" = 0 ] && [ "$logs" = 0 ] && [ "$disguised" = 0 ] && echo PASS || { echo FAIL; exit 1; }

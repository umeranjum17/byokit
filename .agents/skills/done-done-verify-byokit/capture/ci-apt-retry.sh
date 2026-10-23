#!/bin/sh
# Drive the CI apt step's own script from .github/workflows/ci.yml against a fake `sudo` that fails
# a set number of apt calls: the loop retries and passes, passes first time, and gives up after three
# failed attempts. No network, no real apt. Writes ci-apt-retry.log into $DONE_DONE_EVIDENCE_ROOT.
set -u
out="${DONE_DONE_EVIDENCE_ROOT:?}/ci-apt-retry.log"
work=$(mktemp -d); trap 'rm -rf -- "$work"' EXIT
mkdir "$work/bin"
python3 - "$work" <<'P'
import sys, yaml
d = yaml.safe_load(open('.github/workflows/ci.yml'))
for job in ('record-recorder', 'secrets-keyring'):
    step = next(s for s in d['jobs'][job]['steps'] if 'apt-get' in s.get('run', ''))
    print(f"{job}: step timeout-minutes {step['timeout-minutes']}, job timeout-minutes {d['jobs'][job]['timeout-minutes']}")
    open(f"{sys.argv[1]}/{job}.sh", 'w').write(step['run'])
P
cat > "$work/bin/sudo" <<'F'
#!/bin/sh
# fake sudo: the first $FAIL_CALLS apt-get calls exit 100 (a mirror hang), the rest succeed
n=$(cat "$COUNT" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$COUNT"
echo "fake apt-get call $n: $*" >&2
[ "$n" -le "$FAIL_CALLS" ] && exit 100
exit 0
F
printf '#!/bin/sh\nexit 0\n' > "$work/bin/sleep"
chmod +x "$work/bin/sudo" "$work/bin/sleep"
status=0
{
  for job in record-recorder secrets-keyring; do
    # 0 failed calls: first try passes. 2: two attempts hang, the third passes.
    # 100: every attempt fails, so the step must exit non-zero after exactly three attempts.
    for fails in 0 2 100; do
      COUNT="$work/count"; rm -f "$COUNT"
      echo "== $job, first $fails apt calls fail"
      PATH="$work/bin:$PATH" COUNT="$COUNT" FAIL_CALLS=$fails sh -e "$work/$job.sh" 2>&1; code=$?
      echo "exit=$code apt-calls=$(cat "$COUNT")"
      case $fails:$code in 0:0|2:0|100:1) ;; *) echo "UNEXPECTED exit"; status=1 ;; esac
    done
  done
  echo "RESULT: $([ $status = 0 ] && echo PASS || echo FAIL)"
} > "$out" 2>&1
python3 - <<'P' >> "$out"
import yaml
s = open('.github/workflows/ci.yml').read()
print('flags present:', all(f in s for f in ('Acquire::Retries=3', 'Acquire::http::Timeout=30', 'Acquire::https::Timeout=30')))
P
cat "$out"
exit $status

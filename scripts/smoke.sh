#!/usr/bin/env bash
# Isolated end-to-end smoke test. Run via:
#   firebase emulators:exec --config firebase.integration.json --project demo-vizzybl 'bash scripts/smoke.sh'
# Starts a production server on :3099 against the emulator, seeds, signs up
# (twice, to prove idempotency), loads the hosted page, then tears down.
set -uo pipefail
PORT=3099
BASE="http://localhost:$PORT"
export ALLOW_SEED=true
export GOOGLE_CLOUD_PROJECT=demo-vizzybl

npx next start -p "$PORT" >/tmp/next-smoke.log 2>&1 &
NEXT_PID=$!
trap 'kill $NEXT_PID 2>/dev/null' EXIT

for _ in $(seq 1 40); do
  curl -fsS "$BASE/api/health" >/dev/null 2>&1 && break
  sleep 1
done

fail=0
echo "--- seed ---"
curl -s -X POST "$BASE/api/dev/seed"; echo

echo "--- signup (new, expect 201) ---"
code=$(curl -s -o /tmp/s1.json -w "%{http_code}" -X POST "$BASE/api/waitlist/beta-launch/signup" \
  -H 'content-type: application/json' -d '{"email":"smoke@test.com"}')
echo "HTTP $code"; cat /tmp/s1.json; echo
[ "$code" = "201" ] || fail=1

echo "--- signup (same email again, expect 200 alreadyJoined) ---"
code=$(curl -s -o /tmp/s2.json -w "%{http_code}" -X POST "$BASE/api/waitlist/beta-launch/signup" \
  -H 'content-type: application/json' -d '{"email":"smoke@test.com"}')
echo "HTTP $code"; cat /tmp/s2.json; echo
[ "$code" = "200" ] || fail=1
grep -q '"alreadyJoined":true' /tmp/s2.json || fail=1

echo "--- signup (bad input, expect 400) ---"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/waitlist/beta-launch/signup" \
  -H 'content-type: application/json' -d '{"email":"not-an-email"}')
echo "HTTP $code"; [ "$code" = "400" ] || fail=1

echo "--- hosted page (expect 200 + waitlist name) ---"
code=$(curl -s -o /tmp/page.html -w "%{http_code}" "$BASE/waitlist/beta-launch")
echo "HTTP $code"; grep -q "Vizzybl Beta" /tmp/page.html && echo "page renders campaign ✓" || fail=1

echo "--- unknown campaign (expect 404) ---"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/waitlist/nope/signup" \
  -H 'content-type: application/json' -d '{"email":"x@y.com"}')
echo "HTTP $code"; [ "$code" = "404" ] || fail=1

echo "--- referral: B joins via A's token (expect 201) ---"
REF=$(sed -n 's/.*"referralToken":"\([A-Z0-9]*\)".*/\1/p' /tmp/s1.json | head -1)
echo "referrer token: $REF"
code=$(curl -s -o /tmp/b.json -w "%{http_code}" -X POST "$BASE/api/waitlist/beta-launch/signup" \
  -H 'content-type: application/json' -d "{\"email\":\"referred@test.com\",\"referredBySignupToken\":\"$REF\"}")
echo "HTTP $code"; [ "$code" = "201" ] || fail=1

echo "--- leaderboard (expect referrer with 1 referral, PII masked) ---"
curl -s "$BASE/api/waitlist/beta-launch/leaderboard" -o /tmp/lb.json
cat /tmp/lb.json; echo
grep -q '"amount_referred":1' /tmp/lb.json || fail=1
if grep -q 'smoke@test.com' /tmp/lb.json; then echo "PII LEAK in leaderboard"; fail=1; fi

echo "--- leaderboard cache header (expect s-maxage) ---"
curl -s -D - -o /dev/null "$BASE/api/waitlist/beta-launch/leaderboard" | grep -i "cache-control" || fail=1

echo "==== SMOKE $([ $fail -eq 0 ] && echo PASS || echo FAIL) ===="
exit $fail

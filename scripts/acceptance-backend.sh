#!/usr/bin/env bash
# scripts/acceptance-backend.sh — Unit A acceptance (DESIGN.md §G/H)
#
# Proves the backend AC end to end against a running dev server:
#   1. token → post(+receipt) → reply → react → accept
#   2. GET /api/feed?mode=agent ranks the accepted post #1
#   3. GET /api/bootstrap unauthenticated returns the full payload
#   4. viewer detection writes correct viewer_type for all 4 cases (§B)
#   5. rate-limit burst: 60 writes/min/agent → 429 by write #61 (§B, Unit A gap)
#
# Requires: curl, python3, psql (local DB), a dev server on $BASE (default :3011).
# Usage: BASE=http://localhost:3011 bash scripts/acceptance-backend.sh
set -euo pipefail

BASE="${BASE:-http://localhost:3011}"
DB_URL="${DATABASE_URL:-postgresql://adrianagne@localhost:5432/agentsocial}"
PSQL="psql ${DB_URL} -X -q -t -A -v ON_ERROR_STOP=1"
HANDLE="acctest-$(date +%s)-$$"
ANON="anon-acctest-$$"
FAILS=0

say()  { printf '\n== %s\n' "$1"; }
ok()   { printf '   PASS: %s\n' "$1"; }
bad()  { printf '   FAIL: %s\n' "$1"; FAILS=$((FAILS+1)); }
assert_eq() { # assert_eq <name> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1 = $3"; else bad "$1: got '$2' want '$3'"; fi
}
jget() { # jget <json> <python expr on d> — never kills the script; empty on parse failure
  printf '%s' "$1" | python3 -c "import json,sys
try:
    d=json.load(sys.stdin); print($2)
except Exception:
    print('')" 2>/dev/null
}

# wait for the dev server (it recompiles on sibling edits and can briefly 404)
for i in $(seq 1 30); do
  CODE=$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$BASE/api/bootstrap" || echo 000)
  [ "$CODE" = "200" ] && break
  sleep 1
done
if [ "${CODE:-000}" != "200" ]; then printf 'FATAL: no server at %s (bootstrap=%s)\n' "$BASE" "$CODE"; exit 2; fi

# ---------- 1. token ----------
say "1. POST /api/auth/token {handle, claim:'anonymous'}"
TOKEN_RES=$(curl -s -X POST "$BASE/api/auth/token" -H 'Content-Type: application/json' \
  -H 'Accept: application/json' -A 'curl/8.4' \
  -d "{\"handle\":\"$HANDLE\",\"claim\":\"anonymous\"}")
TOKEN=$(jget "$TOKEN_RES" "d.get('token','')")
AGENT_ID=$(jget "$TOKEN_RES" "d.get('agent_id','')")
assert_eq "token prefix" "${TOKEN:0:3}" "as_"
assert_eq "token length (as_+48hex)" "${#TOKEN}" "51"
[ -n "$AGENT_ID" ] && ok "agent_id=$AGENT_ID" || bad "no agent_id in $TOKEN_RES"
AUTH="Authorization: Bearer $TOKEN"

# ---------- 2. post with receipt ----------
say "2. POST /api/posts {board:'solutions', kind:'solution', receipt:[2 steps]}"
POST_RES=$(curl -s -X POST "$BASE/api/posts" -H "$AUTH" -H 'Content-Type: application/json' \
  -H 'Accept: application/json' -A 'curl/8.4' -d '{
    "board":"solutions",
    "kind":"solution",
    "title":"Acceptance: pinning a flaky webhook",
    "body_md":"Replayed the failed delivery after signing the payload; receipt attached.",
    "receipt":[
      {"tool":"stripe.webhooks.construct_event","args_digest":"sha256:ab12", "ok":true, "ms":42, "at":"2026-09-05T00:00:00Z"},
      {"tool":"http.post retry","args_digest":"sha256:cd34", "ok":false, "error":"timeout", "ms":900, "at":"2026-09-05T00:00:01Z"}
    ]}')
POST_ID=$(jget "$POST_RES" "d.get('id','')")
assert_eq "post id prefix" "${POST_ID:0:4}" "pst_"
assert_eq "receipt steps echo" "$(jget "$POST_RES" "d['receipt']['steps']")" "2"
assert_eq "receipt failed echo" "$(jget "$POST_RES" "d['receipt']['failed']")" "1"

# ---------- 3. reply + react + accept ----------
say "3. reply → react → accept"
REPLY_RES=$(curl -s -X POST "$BASE/api/posts/$POST_ID/replies" -H "$AUTH" \
  -H 'Content-Type: application/json' -H 'Accept: application/json' -A 'curl/8.4' \
  -d '{"body_md":"Retry with the raw body and verify the signature — worked on the third attempt."}')
REPLY_ID=$(jget "$REPLY_RES" "d.get('id','')")
assert_eq "reply id prefix" "${REPLY_ID:0:4}" "rpl_"

REACT_CODE=$(curl -s -o /tmp/acc_react.json -w '%{http_code}' -X POST "$BASE/api/posts/$POST_ID/reactions" \
  -H "$AUTH" -H 'Content-Type: application/json' -H 'Accept: application/json' -A 'curl/8.4' \
  -d '{"kind":"upvote"}')
assert_eq "react upvote status" "$REACT_CODE" "201"

ACCEPT_CODE=$(curl -s -o /tmp/acc_accept.json -w '%{http_code}' -X POST "$BASE/api/replies/$REPLY_ID/accept" \
  -H "$AUTH" -H 'Accept: application/json' -A 'curl/8.4')
assert_eq "accept status" "$ACCEPT_CODE" "200"

DETAIL=$(curl -s "$BASE/api/posts/$POST_ID" -H 'Accept: application/json' -A 'curl/8.4')
assert_eq "accepted_reply_id in detail" "$(jget "$DETAIL" "d.get('accepted_reply_id')")" "$REPLY_ID"
assert_eq "detail exposes reply body" "$(jget "$DETAIL" "d['replies'][0]['body_md'][:6]")" "Retry "
assert_eq "detail exposes full trace" "$(jget "$DETAIL" "len(d['receipt']['trace'])")" "2"

# exactly-one-per-post: accepting a different reply would move the flag (only one reply here)

# ---------- 4. feed ranks accepted post #1 ----------
sleep 1
say "4. GET /api/feed?mode=agent → accepted post is #1"
FEED=$(curl -s "$BASE/api/feed?mode=agent&limit=20" -H 'Accept: application/json' -A 'curl/8.4')
assert_eq "feed #1 id" "$(jget "$FEED" "d['items'][0]['id']")" "$POST_ID"
assert_eq "feed #1 accepted_reply_id" "$(jget "$FEED" "d['items'][0]['accepted_reply_id']")" "$REPLY_ID"
SCORE=$(jget "$FEED" "d['items'][0]['score']")
python3 -c "import sys; sys.exit(0 if $SCORE > 5 else 1)" && ok "feed #1 score=$SCORE (accept term dominant)" || bad "feed #1 score=$SCORE unexpectedly low"
CACHE=$( $PSQL -c "SELECT score_cache IS NOT NULL FROM posts WHERE id='$POST_ID';" )
assert_eq "posts.score_cache written" "$CACHE" "t"

# ---------- 5. bootstrap unauthenticated ----------
say "5. GET /api/bootstrap (no auth) → full discovery payload"
BOOT=$(curl -s "$BASE/api/bootstrap" -H 'Accept: application/json' -A 'curl/8.4')
assert_eq "site" "$(jget "$BOOT" "d['site']")" "agent.social"
assert_eq "boards count" "$(jget "$BOOT" "len(d['boards'])")" "5"
assert_eq "mcp url" "$(jget "$BOOT" "d['mcp']['url']")" "$BASE/api/mcp"
assert_eq "mcp tools count" "$(jget "$BOOT" "len(d['mcp']['tools'])")" "9"
assert_eq "rate limit" "$(jget "$BOOT" "d['rate_limits']['writes_per_min_per_agent']")" "60"
assert_eq "feed modes" "$(jget "$BOOT" "d['feed_modes']")" "['agent', 'human', 'blended']"

# ---------- 6. viewer detection: all 4 cases (§B) ----------
say "6. resolveViewer writes correct viewer_type for all 4 cases"
VIEW_SQL="SELECT viewer_type, viewer_confidence::text, COALESCE(anon_id,'-'), COALESCE(viewer_token_id,'-')
          FROM engagement_events WHERE event='view' ORDER BY id DESC LIMIT 1"

# case 1: valid bearer → agent, 1.0, viewer_token_id
curl -s "$BASE/api/feed?mode=agent&limit=1" -H "$AUTH" -A 'acctest' -H 'Accept: application/json' > /dev/null
ROW=$( $PSQL -c "SELECT viewer_type||'|'||viewer_confidence||'|'||COALESCE(viewer_token_id,'-') FROM engagement_events WHERE event='view' ORDER BY id DESC LIMIT 1;" )
assert_eq "case1 (bearer)" "$ROW" "agent|1|$AGENT_ID"

# case 2: anon_id cookie + browser UA → human, 0.95, anon_id
curl -s "$BASE/api/feed?mode=blended&limit=1" -H "Cookie: anon_id=$ANON" \
  -A 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36' > /dev/null
ROW=$( $PSQL -c "SELECT viewer_type||'|'||viewer_confidence||'|'||COALESCE(anon_id,'-') FROM engagement_events WHERE event='view' ORDER BY id DESC LIMIT 1;" )
assert_eq "case2 (browser session)" "$ROW" "human|0.95|$ANON"

# case 3: no token, agent UA signature (curl+JSON Accept) → agent, 0.6
curl -s "$BASE/api/feed?mode=agent&limit=1" -A 'curl/8.4' -H 'Accept: application/json' > /dev/null
ROW=$( $PSQL -c "SELECT viewer_type||'|'||viewer_confidence FROM engagement_events WHERE event='view' ORDER BY id DESC LIMIT 1;" )
assert_eq "case3 (agent UA)" "$ROW" "agent|0.6"

# case 4: browser UA, no token, no cookie → unknown, 0.1
curl -s "$BASE/api/feed?mode=agent&limit=1" \
  -A 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36' > /dev/null
ROW=$( $PSQL -c "SELECT viewer_type||'|'||viewer_confidence FROM engagement_events WHERE event='view' ORDER BY id DESC LIMIT 1;" )
assert_eq "case4 (unknown)" "$ROW" "unknown|0.1"

# §B rule: API client WITH cookie but no token = unknown, never human
curl -s "$BASE/api/feed?mode=agent&limit=1" -H "Cookie: anon_id=$ANON" -A 'curl/8.4' -H 'Accept: application/json' > /dev/null
ROW=$( $PSQL -c "SELECT viewer_type||'|'||viewer_confidence FROM engagement_events WHERE event='view' ORDER BY id DESC LIMIT 1;" )
assert_eq "rule (API client + cookie = unknown)" "$ROW" "unknown|0.1"

# ---------- 7. MCP server answers ----------
say "7. POST /api/mcp (JSON-RPC) initialize + tools/list + tools/call feed"
INIT=$(curl -s -X POST "$BASE/api/mcp" -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -A 'mcp-client/1.0' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}')
assert_eq "mcp server name" "$(jget "$INIT" "d['result']['serverInfo']['name']")" "agent-social"
TOOLS=$(curl -s -X POST "$BASE/api/mcp" -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -A 'mcp-client/1.0' -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')
assert_eq "mcp tools/list count" "$(jget "$TOOLS" "len(d['result']['tools'])")" "9"
MCPCALL=$(curl -s -X POST "$BASE/api/mcp" -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -A 'mcp-client/1.0' -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"feed","arguments":{"mode":"agent","limit":3}}}')
assert_eq "mcp tools/call feed returns items" "$(jget "$MCPCALL" "len(json.loads(d['result']['content'][0]['text'])['items']) > 0")" "True"

# ---------- 8. rate-limit burst: 60 writes/min/agent (§B) ----------
# Unit A declared gap: "rate-limit burst not proven". Fresh agent (full 60/min
# budget), one post (write #1), then reply attempts: writes #2..#61. The 60th
# reply (write #61) must get 429, and the agent stays limited afterwards.
say "8. rate limit: 60 writes/min/agent → 429 by write #61"
BURST_HANDLE="burst-$(date +%s)-$$"
BTOKEN_RES=$(curl -s -X POST "$BASE/api/auth/token" -H 'Content-Type: application/json' \
  -H 'Accept: application/json' -A 'curl/8.4' \
  -d "{\"handle\":\"$BURST_HANDLE\",\"claim\":\"anonymous\"}")
BTOKEN=$(jget "$BTOKEN_RES" "d.get('token','')")
BAGENT_ID=$(jget "$BTOKEN_RES" "d.get('agent_id','')")
if [ -n "$BTOKEN" ]; then ok "burst agent $BAGENT_ID"; else bad "burst token request failed: $BTOKEN_RES"; fi
BAUTH="Authorization: Bearer $BTOKEN"

BURST_POST_ID=""
if [ -n "$BTOKEN" ]; then
  BURST_RES=$(curl -s -X POST "$BASE/api/posts" -H "$BAUTH" -H 'Content-Type: application/json' \
    -H 'Accept: application/json' -A 'curl/8.4' -d '{
      "board":"solutions",
      "kind":"solution",
      "title":"Acceptance: rate-limit burst target",
      "body_md":"Target post for the 61-write burst check."}')
  BURST_POST_ID=$(jget "$BURST_RES" "d.get('id','')")
  [ -n "$BURST_POST_ID" ] && ok "burst post $BURST_POST_ID (write #1)" || bad "burst post failed: $BURST_RES"

  LIMITED_AT=""
  if [ -n "$BURST_POST_ID" ]; then
    for i in $(seq 1 60); do
      CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/posts/$BURST_POST_ID/replies" \
        -H "$BAUTH" -H 'Content-Type: application/json' -H 'Accept: application/json' -A 'curl/8.4' \
        -d "{\"body_md\":\"burst write #$i (rate-limit proof)\"}")
      if [ "$CODE" = "429" ]; then LIMITED_AT=$i; break; fi
      if [ "$CODE" != "200" ] && [ "$CODE" != "201" ]; then
        bad "burst write #$i (write #$((i+1))): unexpected status $CODE"
        break
      fi
    done
    # post = write #1 → reply #N is write #N+1; the limit bites at write #61
    assert_eq "429 at write #61 (burst reply #60)" "$LIMITED_AT" "60"

    STILL=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/posts/$BURST_POST_ID/replies" \
      -H "$BAUTH" -H 'Content-Type: application/json' -H 'Accept: application/json' -A 'curl/8.4' \
      -d '{"body_md":"still limited after the 429"}')
    assert_eq "agent stays limited after 429" "$STILL" "429"
  fi
fi

# ---------- cleanup (throwaway rows only) ----------
say "cleanup: removing acceptance rows"
psql "${DB_URL}" -X -q -t -A -v ON_ERROR_STOP=1 > /dev/null <<SQL
BEGIN;
DELETE FROM engagement_events WHERE post_id='$POST_ID' OR anon_id='$ANON' OR viewer_token_id='$AGENT_ID';
DELETE FROM reactions WHERE post_id='$POST_ID' OR agent_id='$AGENT_ID';
DELETE FROM replies WHERE post_id='$POST_ID';
DELETE FROM post_receipts WHERE post_id='$POST_ID';
DELETE FROM posts WHERE id='$POST_ID';
DELETE FROM board_memberships WHERE agent_id='$AGENT_ID';
DELETE FROM author_edge WHERE viewer_id='$AGENT_ID';
DELETE FROM follows WHERE agent_id='$AGENT_ID' OR target_id='$AGENT_ID';
DELETE FROM idempotency_keys WHERE key LIKE 'acc-%';
DELETE FROM agents WHERE id='$AGENT_ID';
DELETE FROM engagement_events WHERE post_id='$BURST_POST_ID' OR viewer_token_id='$BAGENT_ID';
DELETE FROM replies WHERE post_id='$BURST_POST_ID';
DELETE FROM post_receipts WHERE post_id='$BURST_POST_ID';
DELETE FROM posts WHERE id='$BURST_POST_ID';
DELETE FROM board_memberships WHERE agent_id='$BAGENT_ID';
DELETE FROM author_edge WHERE viewer_id='$BAGENT_ID';
DELETE FROM agents WHERE id='$BAGENT_ID';
COMMIT;
SQL
ok "removed $POST_ID / $REPLY_ID / $AGENT_ID (+ burst agent/post)"

printf '\n========================================\n'
if [ "$FAILS" -eq 0 ]; then printf 'ACCEPTANCE: ALL PASS\n'; else printf 'ACCEPTANCE: %d FAILURE(S)\n' "$FAILS"; exit 1; fi

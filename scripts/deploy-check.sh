#!/usr/bin/env bash
# scripts/deploy-check.sh — post-deploy smoke check for agent.social (Unit C).
# Usage: ./scripts/deploy-check.sh https://agent.social
# Prints PASS/FAIL per check and exits non-zero if any failed.

set -u

BASE="${1:-}"
if [ -z "$BASE" ]; then
  echo "usage: $0 <deployed-url>   e.g. $0 https://agent.social"
  exit 2
fi
BASE="${BASE%/}"
CURL="curl -sS -L --max-time 15"

FAILURES=0
check() { # check <name> <required-pattern> <curl-args...>
  local name="$1"; shift
  local pattern="$1"; shift
  local body status
  body=$($CURL -w $'\n%{http_code}' "$@" 2>&1)
  status=$(printf '%s' "$body" | tail -n1)
  local payload
  payload=$(printf '%s' "$body" | sed '$d')
  if [ "$status" != "200" ]; then
    echo "FAIL  $name (HTTP $status)"
    FAILURES=$((FAILURES + 1))
  elif [ -n "$pattern" ] && ! printf '%s' "$payload" | grep -q "$pattern"; then
    echo "FAIL  $name (200 but missing pattern: $pattern)"
    FAILURES=$((FAILURES + 1))
  else
    echo "PASS  $name"
  fi
}

# 1. Bootstrap: 200 + a boards array (§B discovery surface)
check "GET /api/bootstrap (200 + boards array)" '"boards"' "$BASE/api/bootstrap"
if ! $CURL "$BASE/api/bootstrap" 2>/dev/null | grep -q '"boards"'; then
  echo "FAIL  /api/bootstrap: no boards key"
  FAILURES=$((FAILURES + 1))
else
  echo "PASS  /api/bootstrap: boards key present"
fi

# 2-4. Static agent-facing surfaces (§B: llms.txt, skill.md, robots.txt with bot allows)
check "GET /llms.txt (200 + board list + skill link)" 'skill.md' "$BASE/llms.txt"
check "GET /skill.md (200 + token step)" 'api/auth/token' "$BASE/skill.md"
check "GET /robots.txt (allows ClaudeBot)" 'ClaudeBot' "$BASE/robots.txt"
if $CURL "$BASE/robots.txt" 2>/dev/null | grep -q 'Disallow: /api/auth'; then
  echo "PASS  /robots.txt disallows /api/auth"
else
  echo "FAIL  /robots.txt: /api/auth not disallowed"
  FAILURES=$((FAILURES + 1))
fi

# 5. One .md page twin (§B: every HTML page also served as .md).
# The pattern is the renderer's H1, so an HTML page or error blob cannot pass:
# /feed.md must return the actual markdown twin (text/markdown body).
check "GET /feed.md (200, real markdown twin)" '^# agent-social feed' "$BASE/feed.md"

# 6. Agent feed: 200 + scored posts (ranker output, §C)
feed=$($CURL "$BASE/api/feed?mode=agent&limit=5" 2>&1)
if printf '%s' "$feed" | grep -q '"score"'; then
  echo "PASS  GET /api/feed?mode=agent (scored posts)"
else
  echo "FAIL  GET /api/feed?mode=agent (no score field in response)"
  FAILURES=$((FAILURES + 1))
fi

# 7. MCP surface advertised in bootstrap (§B)
if $CURL "$BASE/api/bootstrap" 2>/dev/null | grep -q '"mcp"'; then
  echo "PASS  /api/bootstrap advertises mcp surface"
else
  echo "FAIL  /api/bootstrap: no mcp block"
  FAILURES=$((FAILURES + 1))
fi

echo
if [ "$FAILURES" -gt 0 ]; then
  echo "DEPLOY CHECK: ${FAILURES} failure(s)"
  exit 1
fi
echo "DEPLOY CHECK: all green"

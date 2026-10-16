#!/bin/sh
# scripts/check-no-hardcoded-output.sh: Verify zero hardcoded output / theory in CLI code
# Specification: PROJECT.md Section 23.1, Section 28 (Phase 9 Exit Criteria)

set -e

echo "=== Checking CLI sources for hardcoded theory or canned verdicts ==="

ERRORS=0

# Check for banned theoretical explanatory phrases in src/cli/
BANNED_PATTERNS="is an algorithm|how this works|theoretical explanation|the bully algorithm works by|in this experiment we simulate|this proves that|split brain means|eventual consistency is defined"

for pattern in $(echo "$BANNED_PATTERNS" | tr '|' '\n'); do
  MATCHES=$(grep -rnI "$pattern" src/cli/ || true)
  if [ -n "$MATCHES" ]; then
    echo "ERROR: Banned theory pattern found: '$pattern'"
    echo "$MATCHES"
    ERRORS=$((ERRORS + 1))
  fi
done

if [ "$ERRORS" -gt 0 ]; then
  echo "FAILED: Found $ERRORS violations of Section 23.1 (Output rules: No theory)."
  exit 1
fi

echo "PASS: Zero banned theoretical strings found in src/cli."
exit 0

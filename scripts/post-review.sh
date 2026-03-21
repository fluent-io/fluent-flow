#!/bin/bash
set -e

# Read inputs
PR_NUMBER=$1
ATTEMPT=$2
RESULT_FILE=$3

# Read result and extract fields
RESULT=$(cat "$RESULT_FILE")
STATUS=$(echo "$RESULT" | jq -r '.status')
SUMMARY=$(echo "$RESULT" | jq -r '.summary')
BLOCKING_COUNT=$(echo "$RESULT" | jq '.blocking | length')
ADVISORY_COUNT=$(echo "$RESULT" | jq '.advisory | length')

# Build header
if [ "$STATUS" = "PASS" ]; then
  HEADER="## ✅ Automated Review: PASSED (Attempt $ATTEMPT)"
  REVIEW_EVENT="APPROVE"
else
  HEADER="## ❌ Automated Review: FAILED (Attempt $ATTEMPT)"
  REVIEW_EVENT="REQUEST_CHANGES"
fi

# Start building body
BODY="${HEADER}

**Summary:** ${SUMMARY}
**Blocking issues:** ${BLOCKING_COUNT} | **Advisory notes:** ${ADVISORY_COUNT}"

# Add blocking issues if any
if [ "$BLOCKING_COUNT" -gt 0 ]; then
  BLOCKING_TEXT=$(echo "$RESULT" | jq -r '.blocking[] | "- **\(.file):\(.line)** — \(.issue)\n  > Fix: \(.fix)"')
  BODY="${BODY}

### 🚫 Blocking Issues

${BLOCKING_TEXT}"
fi

# Add advisory notes if any
if [ "$ADVISORY_COUNT" -gt 0 ]; then
  ADVISORY_TEXT=$(echo "$RESULT" | jq -r '.advisory[] | "- **\(.file):\(.line)** — \(.issue)\n  > Suggestion: \(.suggestion)"')
  BODY="${BODY}

### 💡 Advisory Notes

${ADVISORY_TEXT}"
fi

# Add machine-readable result
MACHINE_RESULT=$(echo "$RESULT" | jq -c '.')
BODY="${BODY}

<!-- reviewer-result: ${MACHINE_RESULT} -->"

# Post review
if [ "$STATUS" = "PASS" ]; then
  gh pr review "$PR_NUMBER" --body "$BODY" --approve 2>/dev/null || \
  gh pr comment "$PR_NUMBER" --body "$BODY"
else
  gh pr review "$PR_NUMBER" --body "$BODY" --request-changes 2>/dev/null || \
  gh pr comment "$PR_NUMBER" --body "$BODY"
fi
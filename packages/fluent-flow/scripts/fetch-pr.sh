#!/bin/bash
set -e

PR_NUMBER=$1
OUTPUT_DIFF=$2
OUTPUT_META=$3

# Fetch PR diff
DIFF=$(gh pr diff "$PR_NUMBER" --patch 2>/dev/null | head -c 66560)
if [ -z "$DIFF" ]; then
  echo "ERROR: Could not fetch PR diff" >&2
  exit 1
fi
echo "$DIFF" > "$OUTPUT_DIFF"
DIFF_SIZE=$(wc -c < "$OUTPUT_DIFF")
echo "diff_size=$DIFF_SIZE" >> $GITHUB_OUTPUT
echo "Fetched diff: $DIFF_SIZE bytes"

# Fetch PR metadata
PR_JSON=$(gh pr view "$PR_NUMBER" --json title,body,author,baseRefName,headRefName,files)
echo "$PR_JSON" > "$OUTPUT_META"
TITLE=$(echo "$PR_JSON" | jq -r '.title')
echo "pr_title=$TITLE" >> $GITHUB_OUTPUT
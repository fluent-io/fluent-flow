#!/usr/bin/env bash
# Verify every .sql migration file has a matching _journal.json entry and vice-versa.
set -euo pipefail

MIGRATIONS_DIR="packages/db/src/migrations"
JOURNAL="$MIGRATIONS_DIR/meta/_journal.json"

if [ ! -f "$JOURNAL" ]; then
  echo "ERROR: $JOURNAL not found"
  exit 1
fi

# Extract tags from journal (drizzle's migration names = filenames without .sql)
journal_tags=$(python3 -c "
import json, sys
j = json.load(open('$JOURNAL'))
for e in j.get('entries', []):
    print(e['tag'])
")

# Extract tags from .sql files
sql_tags=$(ls "$MIGRATIONS_DIR"/*.sql 2>/dev/null | xargs -I{} basename {} .sql | sort)

# Diff: journal entries without a corresponding .sql file
journal_only=$(comm -23 <(echo "$journal_tags" | sort) <(echo "$sql_tags"))
# Diff: .sql files without a corresponding journal entry
sql_only=$(comm -13 <(echo "$journal_tags" | sort) <(echo "$sql_tags"))

failed=0

if [ -n "$journal_only" ]; then
  echo "ERROR: Journal entries missing .sql files:"
  echo "$journal_only" | sed 's/^/  /'
  failed=1
fi

if [ -n "$sql_only" ]; then
  echo "ERROR: .sql files missing from journal:"
  echo "$sql_only" | sed 's/^/  /'
  failed=1
fi

if [ "$failed" -eq 0 ]; then
  echo "OK: All migrations match between disk and journal"
fi

exit $failed

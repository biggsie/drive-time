#!/usr/bin/env bash
# Hourly collection loop, run by .github/workflows/collect.yml.
#
# GitHub's own hourly cron proved unreliable for this repo (in practice it fired
# about every 8 hours), so one workflow run stays alive for ~5.5 hours, collecting
# at :17 past each hour, and then the workflow starts the next run itself.
#
# A reading is skipped if the last one is under 50 minutes old, so overlapping
# runs (cron backstop, manual runs) never double up on API calls.

set -euo pipefail

LOOP_MINUTES="${LOOP_MINUTES:-330}"     # stop starting new waits after this long
COLLECT_MINUTE="${COLLECT_MINUTE:-17}"  # minute past the hour to collect
MIN_GAP_MINUTES="${MIN_GAP_MINUTES:-50}"

deadline=$(( $(date -u +%s) + LOOP_MINUTES * 60 ))

git config user.name "drive-time-bot"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

last_reading_age_minutes() {
  python3 - <<'PY'
import json, sys
from datetime import datetime, timezone
try:
    ts = json.load(open("data/latest.json"))["generated_at_utc"]
    t = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    print(int((datetime.now(timezone.utc) - t).total_seconds() // 60))
except Exception:
    print(99999)
PY
}

commit_and_push() {
  git add data
  if git diff --cached --quiet; then
    echo "No changes to commit."
    return 0
  fi
  git commit -q -m "data: readings $(date -u +%Y-%m-%dT%H:%MZ)"
  for i in 1 2 3 4; do
    if git push -q; then return 0; fi
    sleep $((i * 5))
    git pull -q --rebase
  done
  echo "Push failed after retries." >&2
  return 1
}

while :; do
  git pull -q --rebase || echo "git pull failed; continuing with local copy" >&2

  age=$(last_reading_age_minutes)
  if (( age >= MIN_GAP_MINUTES )); then
    echo "$(date -u +%H:%MZ) last reading ${age} min old: collecting"
    if python3 scripts/collect.py; then
      commit_and_push || true
    else
      echo "Collection failed this hour; will try again next hour." >&2
    fi
  else
    echo "$(date -u +%H:%MZ) last reading ${age} min old: skipping"
  fi

  # Next :17 past the hour that is still ahead of us.
  now=$(date -u +%s)
  next=$(( now - now % 3600 + COLLECT_MINUTE * 60 ))
  while (( next <= now + 60 )); do next=$(( next + 3600 )); done

  if (( next > deadline )); then
    echo "Next slot is past this run's window; handing over to the next run."
    exit 0
  fi
  echo "Sleeping until $(date -u -d "@$next" +%H:%MZ)"
  sleep $(( next - now ))
done

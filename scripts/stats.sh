#!/usr/bin/env bash
# How is it doing? npm downloads (once the registry indexes them) and GitHub interest.
set -uo pipefail
pkg=opencode-dictate
repo=rodri45l/opencode-dictate

echo "npm downloads"
for period in last-day last-week last-month; do
  n=$(curl -sS "https://api.npmjs.org/downloads/point/$period/$pkg" 2>/dev/null \
      | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('downloads','not indexed yet'))" 2>/dev/null)
  printf "  %-11s %s\n" "$period" "${n:-not indexed yet}"
done

echo
echo "github"
if command -v gh >/dev/null; then
  gh repo view "$repo" --json stargazerCount,forkCount,openIssuesCount,visibility 2>/dev/null \
    | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('  stars:      ', d.get('stargazerCount'))
print('  forks:      ', d.get('forkCount'))
print('  open issues:', d.get('openIssuesCount'))
print('  visibility: ', d.get('visibility'))
" 2>/dev/null || echo "  (gh unavailable)"
fi

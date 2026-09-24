#!/bin/bash
# PostToolUse hook: prettier --check on .ts/.html/.css/.mjs files after Edit/Write.
f=$(jq -r '.tool_input.file_path')
echo "$f" | grep -qE '\.(ts|html|css|mjs)$' || exit 0
cd "$(git rev-parse --show-toplevel)" && npx prettier --check "$f" 2>&1 | head -5

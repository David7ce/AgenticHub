#!/usr/bin/env bash
# run-opencode.sh <workdir> <promptfile> <model>
# Runs one OpenCode prompt headlessly inside WSL. Called by hub.ps1.
# stdin is closed on purpose: `opencode run` hangs waiting on it otherwise.
cd "$1" || exit 3
"${OPENCODE_BIN:-opencode}" run -m "$3" "$(cat "$2")" < /dev/null 2>&1

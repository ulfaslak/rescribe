#!/bin/sh
# The harness's routine (e2e/routines.spec.ts): what a real one gets, written down, and a summary.
set -e
{
  echo "dir=$RESCRIBE_RECORDING_DIR"
  echo "title=$RESCRIBE_TITLE"
  head -1 "$RESCRIBE_RECORDING_DIR/transcript.md"
} >"$RESCRIBE_RUN_DIR/seen.txt"
echo "working on $RESCRIBE_TITLE"
# Long enough for the row to show it running.
sleep 2
echo "Echoed $RESCRIBE_TITLE" >"$RESCRIBE_RUN_DIR/summary.txt"

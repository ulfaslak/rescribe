#!/bin/bash
# Generates the speech fixture used as the fake microphone in e2e runs.
# macOS only (uses `say`; the default voice renders nothing from a non-interactive shell, hence -v). Output: 16 kHz, 16-bit, mono WAV.
set -euo pipefail
cd "$(dirname "$0")/.."
TEXT="This is a Rescribe test recording. The quick brown fox jumps over the lazy dog. Speaker attribution should work across two channels."
say -v Samantha -o e2e/fixtures/speech.wav --file-format=WAVE --data-format=LEI16@16000 "$TEXT"
echo "$TEXT" > e2e/fixtures/speech.txt
ls -la e2e/fixtures/speech.wav

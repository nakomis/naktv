#!/usr/bin/env bash
# The music library's side of the feed (NAKTV-26): random tracks from the CC
# library, decoded and paced to real time into LIBRARY_FIFO, beside Spotify's
# pipe. music-switch.py picks which of the two reaches go2rtc.
#
# Run under systemd, which restarts the pair: the pacer exits at EOF, and the
# player dies of a broken pipe if the pacer goes, so either side ending ends
# the pipeline.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${LIBRARY_FIFO:=/run/naktv/library.pcm}"
: "${PYTHON_BIN:=python3}"

"$PYTHON_BIN" "$HERE/library-player.py" | "$PYTHON_BIN" "$HERE/pcm-pacer.py" --output "$LIBRARY_FIFO"

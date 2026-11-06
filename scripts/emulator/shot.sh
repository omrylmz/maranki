#!/bin/zsh
# Take a screenshot of the Android emulator without corrupting the PNG.
# Usage: scripts/emulator/shot.sh <out-dir> <name>
# This AVD has 2 displays: plain `screencap -p` prints a warning into stdout and breaks
# the file, so pass the display id (find it with: adb shell dumpsys SurfaceFlinger --display-id).
DISPLAY_ID=${DISPLAY_ID:-4619827259835644672}
mkdir -p "$1"
adb -s ${ANDROID_SERIAL:-emulator-5554} exec-out screencap -p -d $DISPLAY_ID > "$1/$2.png"
file "$1/$2.png" | cut -d: -f2

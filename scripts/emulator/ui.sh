#!/bin/zsh
# Print every on-screen element with text or an accessibility label, with its bounds
# (C = clickable, X = checked, S = selected). Fails on screens with endless animations.
# Usage: scripts/emulator/ui.sh
T=$(mktemp -d)
adb -s ${ANDROID_SERIAL:-emulator-5554} shell rm -f /sdcard/ui.xml
adb -s ${ANDROID_SERIAL:-emulator-5554} shell uiautomator dump /sdcard/ui.xml 2>&1 | grep -i error && exit 1
adb -s ${ANDROID_SERIAL:-emulator-5554} exec-out cat /sdcard/ui.xml > $T/ui.xml
python3 -I - $T/ui.xml <<'PY'
import sys, xml.etree.ElementTree as ET
for n in ET.parse(sys.argv[1]).iter('node'):
    txt, cd = n.get('text') or '', n.get('content-desc') or ''
    if txt or cd:
        f = ('C' if n.get('clickable') == 'true' else '') + ('X' if n.get('checked') == 'true' else '') + ('S' if n.get('selected') == 'true' else '')
        print(f"{n.get('bounds'):28} {f:3} text={txt!r} desc={cd!r}")
PY

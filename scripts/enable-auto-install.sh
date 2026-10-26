#!/bin/zsh
# Run ipad-install.sh every 15 minutes in the background, so plugging the iPad into this Mac keeps the app signed.
# Undo with: launchctl bootout gui/$(id -u)/kr.ac.snu.lecturenotes.install && rm ~/Library/LaunchAgents/kr.ac.snu.lecturenotes.install.plist
set -euo pipefail

LABEL=kr.ac.snu.lecturenotes.install
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SCRIPT=${0:A:h}/ipad-install.sh

cat >"$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/zsh</string><string>-lc</string><string>"$SCRIPT"</string></array>
  <key>StartInterval</key><integer>900</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/lecture-notes-install.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/lecture-notes-install.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Enabled. Log: ~/Library/Logs/lecture-notes-install.log"

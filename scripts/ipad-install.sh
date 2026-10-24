#!/bin/zsh
# Build the app and install it on a connected iPad.
#
# Development builds signed with a free Apple ID stop opening when their 7-day provisioning profile
# expires, and reinstalling with the same profile doesn't move that date. So this script is meant to
# run regularly (see enable-auto-install.sh): when an iPad is connected and the installed build has
# less than 2 days left, it drops the old profile so Xcode issues a fresh one, then rebuilds and installs.
# Pass --force to install right now.
set -euo pipefail

REPO=${0:A:h:h}
STATE="$HOME/Library/Application Support/lecture-notes"
EXPIRES="$STATE/installed-expires" # epoch seconds when the installed build stops opening
BUILD="$HOME/Library/Caches/lecture-notes-build"
PROFILES="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
APP_ID=kr.ac.snu.lecturenotes
RENEW_BEFORE=$((2 * 86400))
mkdir -p "$STATE"

log() { echo "$(date '+%F %T') $*"; }
expiry_of() { # epoch seconds from a .mobileprovision
  local iso=$(security cms -D -i "$1" 2>/dev/null | plutil -extract ExpirationDate raw -o - -)
  date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$iso" +%s
}

device=$(xcrun devicectl list devices 2>/dev/null |
  awk '/iPad/ && (/ connected / || /available \(paired\)/) { for (i = 1; i <= NF; i++) if ($i ~ /^[0-9A-F]{8}-[0-9A-F]{16}$/) { print $i; exit } }')
if [[ -z $device ]]; then
  log "no iPad connected"
  exit 0
fi
now=$(date +%s)
if [[ ${1:-} != --force && -f $EXPIRES ]] && (( $(<"$EXPIRES") - now > RENEW_BEFORE )); then
  log "installed build is good until $(date -r $(<"$EXPIRES") '+%F %R'), nothing to do"
  exit 0
fi

# A profile close to expiry would just be reused; remove it so Xcode makes a new 7-day one.
for f in "$PROFILES"/*.mobileprovision(N); do
  id=$(security cms -D -i "$f" 2>/dev/null | plutil -extract Entitlements.application-identifier raw -o - - 2>/dev/null || true)
  if [[ $id == *.$APP_ID ]] && (( $(expiry_of "$f") - now < RENEW_BEFORE )); then
    log "removing expiring profile ${f:t}"
    rm "$f"
  fi
done

log "installing on $device"
cd "$REPO"
npm run sync >/dev/null
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug \
  -destination "id=$device" -derivedDataPath "$BUILD" -allowProvisioningUpdates clean build -quiet
app="$BUILD/Build/Products/Debug-iphoneos/App.app"
codesign --verify --deep --strict "$app"
xcrun devicectl device install app --device "$device" "$app" >/dev/null
expiry_of "$app/embedded.mobileprovision" >"$EXPIRES"
log "done, app opens until $(date -r $(<"$EXPIRES") '+%F %R')"

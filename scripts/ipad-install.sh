#!/bin/zsh
# Build the app and install it on a connected iPad.
#
# Development builds signed with a free Apple ID stop opening when their 7-day provisioning profile
# expires, and reinstalling with the same profile doesn't move that date. So this script is meant to
# run regularly (see enable-auto-install.sh): whenever an iPad is connected and the installed build has
# less than 6 days left, it drops the old profile so Xcode issues a fresh 7-day one, then rebuilds and
# installs — so connecting the iPad on any day pushes the deadline to a week from then (at most once a
# day). Pass --force to install right now (a fresh profile is still only requested when it would help).
set -euo pipefail

REPO=${0:A:h:h}
STATE="$HOME/Library/Application Support/lecture-notes"
EXPIRES="$STATE/installed-expires" # epoch seconds when the installed build stops opening
ATTEMPT="$STATE/last-renewal"      # epoch seconds of the last automatic renewal attempt
BUILD="$HOME/Library/Caches/lecture-notes-build"
PROFILES="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
APP_ID=kr.ac.snu.lecturenotes
RENEW_BEFORE=$((6 * 86400)) # renew when less than this is left: about once a day while connected
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
if [[ ${1:-} != --force ]]; then
  if [[ -f $EXPIRES ]] && (( $(<"$EXPIRES") - now > RENEW_BEFORE )); then
    log "installed build is good until $(date -r $(<"$EXPIRES") '+%F %R'), nothing to do"
    exit 0
  fi
  # Once a day at most: if Apple hands back the same profile, don't reinstall every 15 minutes.
  if [[ -f $ATTEMPT ]] && (( now - $(<"$ATTEMPT") < 20 * 3600 )); then
    log "already renewed today, nothing to do"
    exit 0
  fi
  # Never close the app in the middle of a lecture (the app keeps this marker while recording).
  marker=$(mktemp -d)
  if xcrun devicectl device copy from --device "$device" --domain-type appDataContainer \
      --domain-identifier "$APP_ID" --source Documents/.recording-active --destination "$marker/m" >/dev/null 2>&1 \
      && (( now - $(<"$marker/m") < 4 * 3600 )); then
    rm -rf "$marker"
    log "a lecture is being recorded, trying again later"
    exit 0
  fi
  rm -rf "$marker"
  echo "$now" >"$ATTEMPT"
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

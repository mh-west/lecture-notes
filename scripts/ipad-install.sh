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
ATTEMPT="$STATE/last-renewal"      # epoch seconds of the last successful automatic renewal
FAILED="$STATE/last-failure"       # epoch seconds of the last failed one: retried an hour later
NOTIFIED="$STATE/last-notice"      # epoch seconds of the last Mac notification about a problem
BUILD="$HOME/Library/Caches/lecture-notes-build"
PROFILES="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
APP_ID=kr.ac.snu.lecturenotes
RENEW_BEFORE=$((6 * 86400)) # renew when less than this is left: about once a day while connected
mkdir -p "$STATE"

log() { echo "$(date '+%F %T') $*"; }
# A problem only the user can fix (Xcode logged out, iPad locked): tell them on the Mac, at most every
# 3 hours, with how long the app still opens.
notify() {
  local now=$(date +%s) left=""
  [[ -f $NOTIFIED ]] && (( now - $(<"$NOTIFIED") < 3 * 3600 )) && return
  echo "$now" >"$NOTIFIED"
  [[ -f $EXPIRES ]] && left=" (앱은 $(date -r $(<"$EXPIRES") '+%-m/%-d %H:%M')까지 열려요)"
  osascript -e "display notification \"$1$left\" with title \"강의노트 기한 연장 실패\"" >/dev/null 2>&1 || true
}
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
# Never close the app in the middle of a lecture, not even with --force (the app keeps this marker
# while recording).
marker=$(mktemp -d)
if xcrun devicectl device copy from --device "$device" --domain-type appDataContainer \
    --domain-identifier "$APP_ID" --source Documents/.recording-active --destination "$marker/m" >/dev/null 2>&1 \
    && (( now - $(<"$marker/m") < 4 * 3600 )); then
  rm -rf "$marker"
  log "a lecture is being recorded, trying again later"
  exit 0
fi
rm -rf "$marker"
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
  # A failed try (iPad locked, no network…) is tried again an hour later, not a day later.
  if [[ -f $FAILED ]] && (( now - $(<"$FAILED") < 3600 )); then
    log "last try failed less than an hour ago, waiting"
    exit 0
  fi
fi

# Signing needs the Apple account in Xcode; it sometimes gets logged out. Check before touching profiles.
if ! defaults read com.apple.dt.Xcode DVTDeveloperAccountManagerAppleIDLists 2>/dev/null | grep -q 'identifier'; then
  log "Xcode has no Apple account: sign in under Xcode > Settings > Accounts"
  echo "$now" >"$FAILED"
  notify "Xcode에 Apple 계정이 로그아웃돼 있어요. Xcode > Settings > Accounts에서 로그인해 주세요."
  exit 1
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
./scripts/fetch-whisper.sh
npm run sync >/dev/null
out=$(mktemp)
fail() {
  echo "$(date +%s)" >"$FAILED"
  if grep -q "needs to be unlocked" "$out"; then
    log "the iPad is locked"
    notify "iPad 잠금을 풀어 주세요. 다음 시도는 한 시간 뒤예요."
  elif grep -qE "No Accounts|Invalid credentials" "$out"; then
    log "Xcode lost the Apple account"
    notify "Xcode에 Apple 계정으로 다시 로그인해 주세요 (Xcode > Settings > Accounts)."
  else
    log "install failed"
  fi
  rm -f "$out"
  exit 1
}
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug \
  -destination "id=$device" -derivedDataPath "$BUILD" -allowProvisioningUpdates clean build -quiet >"$out" 2>&1 || { cat "$out"; fail; }
app="$BUILD/Build/Products/Debug-iphoneos/App.app"
codesign --verify --deep --strict "$app" || fail
xcrun devicectl device install app --device "$device" "$app" >"$out" 2>&1 || { cat "$out"; fail; }
rm -f "$out" "$FAILED"
expiry_of "$app/embedded.mobileprovision" >"$EXPIRES"
echo "$now" >"$ATTEMPT"
log "done, app opens until $(date -r $(<"$EXPIRES") '+%F %R')"

#!/bin/bash
# Downloads the official whisper.cpp iOS framework (checked against its SHA-256) into
# ios/App/WhisperPkg, keeping only the iPad slice. Run once; ipad-install.sh calls it when missing.
set -euo pipefail
cd "$(dirname "$0")/.."
TAG=b5454
SHA=e57f8c48933000acabc13bb913fbe82805d483a2deff692cc6738836bd92393b
DEST=ios/App/WhisperPkg/whisper.xcframework
[[ -d $DEST/ios-arm64 ]] && exit 0
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -sSL -o "$tmp/w.zip" "https://github.com/ggml-org/whisper.cpp/releases/download/$TAG/whisper-$TAG-xcframework.zip"
echo "$SHA  $tmp/w.zip" | shasum -a 256 -c - >/dev/null
unzip -q "$tmp/w.zip" -d "$tmp"
src="$tmp/build-apple/whisper.xcframework"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$src/ios-arm64" "$DEST/"
# Keep only the device slice in the framework's index.
/usr/bin/python3 - "$src/Info.plist" "$DEST/Info.plist" <<'PY'
import plistlib, sys
p = plistlib.load(open(sys.argv[1], 'rb'))
p['AvailableLibraries'] = [l for l in p['AvailableLibraries'] if l['LibraryIdentifier'] == 'ios-arm64']
plistlib.dump(p, open(sys.argv[2], 'wb'))
PY
echo "whisper.cpp $TAG ready"

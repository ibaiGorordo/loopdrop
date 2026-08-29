#!/bin/sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
package_dir=$(CDPATH= cd -- "$script_dir/.." && pwd -P)
plist_source="$package_dir/Resources/Info.plist"

if [ ! -f "$plist_source" ]; then
    echo "Missing application metadata: $plist_source" >&2
    exit 1
fi

loopdrop_configuration=${LOOPDROP_CONFIGURATION:-release}
loopdrop_marketing_version=${LOOPDROP_MARKETING_VERSION:-$(
    /usr/bin/plutil -extract CFBundleShortVersionString raw "$plist_source"
)}
loopdrop_build_number=${LOOPDROP_BUILD_NUMBER:-$(
    /usr/bin/plutil -extract CFBundleVersion raw "$plist_source"
)}

case "$loopdrop_configuration" in
    debug|release) ;;
    *)
        echo "LOOPDROP_CONFIGURATION must be 'debug' or 'release'." >&2
        exit 2
        ;;
esac

case "$loopdrop_marketing_version" in
    ''|*[!0-9.]*)
        echo "LOOPDROP_MARKETING_VERSION must contain only digits and dots." >&2
        exit 2
        ;;
esac
case "$loopdrop_build_number" in
    ''|*[!0-9]*)
        echo "LOOPDROP_BUILD_NUMBER must be a positive integer." >&2
        exit 2
        ;;
esac

build_root="$package_dir/.build"
arm64_scratch="$build_root/swiftpm-arm64"
x86_64_scratch="$build_root/swiftpm-x86_64"
app_output_root="$build_root/app"
app_bundle="$app_output_root/loopdrop.app"
icon_source="$package_dir/Resources/Loopdrop.icns"
license_source="$package_dir/LICENSE"

# The bundle destination is deliberately fixed beneath this package. Refuse
# symlinked output components before SwiftPM or the packager writes anything.
case "$app_bundle" in
    "$package_dir/.build/app/loopdrop.app") ;;
    *)
        echo "Refusing unexpected bundle destination: $app_bundle" >&2
        exit 1
        ;;
esac
if [ "$package_dir" = / ]; then
    echo "Refusing unsafe package directory: $package_dir" >&2
    exit 1
fi
if [ -L "$build_root" ] || [ -L "$arm64_scratch" ] || [ -L "$x86_64_scratch" ] ||
    [ -L "$app_output_root" ] || [ -L "$app_bundle" ]; then
    echo "Refusing a symlinked build destination beneath $build_root" >&2
    exit 1
fi

if [ ! -f "$icon_source" ]; then
    echo "Missing app icon: $icon_source" >&2
    exit 1
fi
if [ ! -f "$license_source" ]; then
    echo "Missing project license: $license_source" >&2
    exit 1
fi

/bin/mkdir -p "$build_root"

# Build each deployment-targeted slice separately. This also works with the
# standalone Apple Command Line Tools, without an Xcode project.
/usr/bin/swift build \
    --package-path "$package_dir" \
    --scratch-path "$arm64_scratch" \
    --configuration "$loopdrop_configuration" \
    --triple arm64-apple-macosx13.0 \
    --product Loopdrop

arm64_bin_dir=$(/usr/bin/swift build \
    --package-path "$package_dir" \
    --scratch-path "$arm64_scratch" \
    --configuration "$loopdrop_configuration" \
    --triple arm64-apple-macosx13.0 \
    --product Loopdrop \
    --show-bin-path)
arm64_binary="$arm64_bin_dir/Loopdrop"

/usr/bin/swift build \
    --package-path "$package_dir" \
    --scratch-path "$x86_64_scratch" \
    --configuration "$loopdrop_configuration" \
    --triple x86_64-apple-macosx13.0 \
    --product Loopdrop

x86_64_bin_dir=$(/usr/bin/swift build \
    --package-path "$package_dir" \
    --scratch-path "$x86_64_scratch" \
    --configuration "$loopdrop_configuration" \
    --triple x86_64-apple-macosx13.0 \
    --product Loopdrop \
    --show-bin-path)
x86_64_binary="$x86_64_bin_dir/Loopdrop"

if [ ! -x "$arm64_binary" ] || [ ! -x "$x86_64_binary" ]; then
    echo "One or more architecture-specific executables are missing." >&2
    exit 1
fi
arm64_archs=$(/usr/bin/xcrun lipo -archs "$arm64_binary")
x86_64_archs=$(/usr/bin/xcrun lipo -archs "$x86_64_binary")
if [ "$arm64_archs" != arm64 ] || [ "$x86_64_archs" != x86_64 ]; then
    echo "Refusing unexpected thin binaries: arm64='$arm64_archs', x86_64='$x86_64_archs'" >&2
    exit 1
fi

/bin/mkdir -p "$app_output_root"
if [ -L "$build_root" ] || [ -L "$app_output_root" ]; then
    echo "Refusing a symlinked build destination beneath $build_root" >&2
    exit 1
fi
stage_dir=$(/usr/bin/mktemp -d "$build_root/.bundle-stage.XXXXXX")
case "$stage_dir" in
    "$build_root"/.bundle-stage.*) ;;
    *)
        echo "Refusing unexpected staging directory: $stage_dir" >&2
        exit 1
        ;;
esac
cleanup_stage() {
    if [ -n "${stage_dir:-}" ] && [ -d "$stage_dir" ]; then
        /usr/bin/find "$stage_dir" -depth -delete
    fi
}
trap cleanup_stage EXIT HUP INT TERM

staged_bundle="$stage_dir/loopdrop.app"
contents_dir="$staged_bundle/Contents"
macos_dir="$contents_dir/MacOS"
resources_dir="$contents_dir/Resources"
/bin/mkdir -p "$macos_dir" "$resources_dir"

/usr/bin/xcrun lipo \
    -create \
    "$arm64_binary" \
    "$x86_64_binary" \
    -output "$macos_dir/loopdrop"
/bin/chmod 755 "$macos_dir/loopdrop"

universal_archs=$(/usr/bin/xcrun lipo -archs "$macos_dir/loopdrop")
loopdrop_arch_count=0
loopdrop_has_arm64=false
loopdrop_has_x86_64=false
for loopdrop_arch in $universal_archs; do
    loopdrop_arch_count=$((loopdrop_arch_count + 1))
    case "$loopdrop_arch" in
        arm64) loopdrop_has_arm64=true ;;
        x86_64) loopdrop_has_x86_64=true ;;
        *)
            echo "Refusing unexpected packaged architecture: $loopdrop_arch" >&2
            exit 1
            ;;
    esac
done
if [ "$loopdrop_arch_count" -ne 2 ] ||
    [ "$loopdrop_has_arm64" != true ] || [ "$loopdrop_has_x86_64" != true ]; then
    echo "Universal binary verification failed: $universal_archs" >&2
    exit 1
fi
/usr/bin/xcrun lipo "$macos_dir/loopdrop" -verify_arch arm64 x86_64

for loopdrop_arch in arm64 x86_64; do
    loopdrop_minos=$(/usr/bin/xcrun vtool \
        -arch "$loopdrop_arch" \
        -show-build "$macos_dir/loopdrop" |
        /usr/bin/awk '$1 == "minos" { print $2; found = 1; exit } END { if (!found) exit 1 }')
    case "$loopdrop_minos" in
        13.0|13.0.0) ;;
        *)
            echo "Unexpected $loopdrop_arch deployment target: $loopdrop_minos" >&2
            exit 1
            ;;
    esac
done

/usr/bin/install -m 644 "$plist_source" "$contents_dir/Info.plist"
/usr/bin/install -m 644 "$icon_source" "$resources_dir/Loopdrop.icns"
/usr/bin/install -m 644 "$license_source" "$resources_dir/LICENSE"

/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $loopdrop_marketing_version" "$contents_dir/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $loopdrop_build_number" "$contents_dir/Info.plist"
/usr/bin/plutil -lint "$contents_dir/Info.plist"
loopdrop_plist_minos=$(/usr/bin/plutil -extract LSMinimumSystemVersion raw "$contents_dir/Info.plist")
loopdrop_plist_agent=$(/usr/bin/plutil -extract LSUIElement raw "$contents_dir/Info.plist")
if [ "$loopdrop_plist_minos" != 13.0 ] || [ "$loopdrop_plist_agent" != true ]; then
    echo "Packaged plist lost its macOS 13 or LSUIElement metadata." >&2
    exit 1
fi

# Ad-hoc signing makes the local bundle self-consistent. Distribution still
# requires a Developer ID signature and notarization.
/usr/bin/codesign \
    --force \
    --sign - \
    --timestamp=none \
    "$staged_bundle"
/usr/bin/codesign --verify --deep --strict --verbose=2 "$staged_bundle"

if [ -e "$app_bundle" ]; then
    /usr/bin/find "$app_bundle" -depth -delete
fi
/bin/mv "$staged_bundle" "$app_bundle"
/bin/rmdir "$stage_dir"
stage_dir=

echo "Built $app_bundle"

#!/usr/bin/env bash

set -euo pipefail

FFMPEG_VERSION="9.0.1"
FFMPEG_SHA256="cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635"
FFMPEG_SOURCE_URL="https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
ARCHIVE_DIR="${PROJECT_DIR}/vendor/cache"
ARCHIVE_PATH="${ARCHIVE_DIR}/ffmpeg-${FFMPEG_VERSION}.tar.xz"
OUTPUT_DIR="${1:-${PROJECT_DIR}/vendor/ffmpeg/current}"
BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/loopdrop-ffmpeg.XXXXXX")"
DOWNLOAD_PATH=""

cleanup() {
  if [[ -n "${DOWNLOAD_PATH}" ]]; then
    rm -f -- "${DOWNLOAD_PATH}"
  fi
  rm -rf -- "${BUILD_DIR}"
}
trap cleanup EXIT

mkdir -p "${ARCHIVE_DIR}" "${OUTPUT_DIR}"
# Callers normally pass a repository-relative path. Resolve it before changing
# into the extracted FFmpeg source tree so all later writes stay at that path.
OUTPUT_DIR="$(cd "${OUTPUT_DIR}" && pwd -P)"

archive_is_valid=false
if [[ -f "${ARCHIVE_PATH}" ]]; then
  cached_sha="$(shasum -a 256 "${ARCHIVE_PATH}" | awk '{print $1}')"
  if [[ "${cached_sha}" == "${FFMPEG_SHA256}" ]]; then
    archive_is_valid=true
  else
    echo "Ignoring cached FFmpeg source with checksum ${cached_sha}." >&2
  fi
fi

if [[ "${archive_is_valid}" != true ]]; then
  DOWNLOAD_PATH="$(mktemp "${ARCHIVE_DIR}/.ffmpeg-${FFMPEG_VERSION}.XXXXXX")"
  curl --fail --location --retry 3 --retry-all-errors --proto '=https' --tlsv1.2 \
    "${FFMPEG_SOURCE_URL}" \
    --output "${DOWNLOAD_PATH}"
  downloaded_sha="$(shasum -a 256 "${DOWNLOAD_PATH}" | awk '{print $1}')"
  if [[ "${downloaded_sha}" != "${FFMPEG_SHA256}" ]]; then
    echo "FFmpeg source checksum mismatch: expected ${FFMPEG_SHA256}, received ${downloaded_sha}." >&2
    exit 1
  fi
  chmod 0644 "${DOWNLOAD_PATH}"
  mv -f -- "${DOWNLOAD_PATH}" "${ARCHIVE_PATH}"
  DOWNLOAD_PATH=""
fi

tar -xf "${ARCHIVE_PATH}" -C "${BUILD_DIR}"
source_dir="${BUILD_DIR}/ffmpeg-${FFMPEG_VERSION}"
prefix_dir="${BUILD_DIR}/install"

cd "${source_dir}"
./configure \
  --prefix="${prefix_dir}" \
  --extra-version=loopdrop \
  --disable-autodetect \
  --disable-avdevice \
  --disable-debug \
  --disable-doc \
  --disable-encoders \
  --disable-ffplay \
  --disable-gpl \
  --disable-network \
  --disable-nonfree \
  --disable-shared \
  --disable-version3 \
  --disable-muxers \
  --enable-ffmpeg \
  --enable-ffprobe \
  --enable-encoder=gif \
  --enable-encoder=mpeg4 \
  --enable-muxer=gif \
  --enable-muxer=mov \
  --enable-muxer=mp4 \
  --enable-pic \
  --enable-static

if command -v nproc >/dev/null 2>&1; then
  jobs="$(nproc)"
else
  jobs="$(sysctl -n hw.logicalcpu 2>/dev/null || echo 4)"
fi

make -j"${jobs}"
make install

install -m 0755 "${prefix_dir}/bin/ffmpeg" "${OUTPUT_DIR}/ffmpeg"
install -m 0755 "${prefix_dir}/bin/ffprobe" "${OUTPUT_DIR}/ffprobe"
install -m 0644 "${source_dir}/COPYING.LGPLv2.1" "${OUTPUT_DIR}/COPYING.LGPLv2.1"
install -m 0644 "${source_dir}/LICENSE.md" "${OUTPUT_DIR}/FFMPEG-LICENSE.md"
"${prefix_dir}/bin/ffmpeg" -hide_banner -buildconf >"${OUTPUT_DIR}/build-configuration.txt" 2>&1
printf '%s\n' "${FFMPEG_VERSION}" >"${OUTPUT_DIR}/version.txt"
printf '%s\n' "${FFMPEG_SOURCE_URL}" >"${OUTPUT_DIR}/source-url.txt"
printf '%s\n' "${FFMPEG_SHA256}" >"${OUTPUT_DIR}/source-sha256.txt"

if grep -Eq -- '--enable-(gpl|nonfree|version3)' "${OUTPUT_DIR}/build-configuration.txt"; then
  echo "Refusing a GPL, nonfree, or version-3-only FFmpeg build." >&2
  exit 1
fi
for required_flag in \
  --disable-autodetect \
  --disable-gpl \
  --disable-network \
  --disable-nonfree \
  --disable-version3; do
  if ! grep -Fq -- "${required_flag}" "${OUTPUT_DIR}/build-configuration.txt"; then
    echo "Required FFmpeg policy flag is missing: ${required_flag}" >&2
    exit 1
  fi
done

filters="$("${OUTPUT_DIR}/ffmpeg" -hide_banner -filters 2>/dev/null)"
for required_filter in palettegen paletteuse scale testsrc2; do
  if ! grep -q "${required_filter}" <<<"${filters}"; then
    echo "Required FFmpeg filter is unavailable: ${required_filter}" >&2
    exit 1
  fi
done

smoke_gif="${BUILD_DIR}/smoke.gif"
"${OUTPUT_DIR}/ffmpeg" \
  -hide_banner -loglevel error -y \
  -filter_complex 'testsrc2=size=160x90:rate=8:duration=1,split[gif][palette];[palette]palettegen=max_colors=64[paletteout];[gif][paletteout]paletteuse[out]' \
  -map '[out]' -an -loop 0 "${smoke_gif}"

if [[ ! -s "${smoke_gif}" ]]; then
  echo "FFmpeg smoke test did not create an output file." >&2
  exit 1
fi
case "$(head -c 6 "${smoke_gif}")" in
  GIF87a|GIF89a) ;;
  *) echo "FFmpeg smoke test did not create a valid GIF." >&2; exit 1 ;;
esac

echo "Built redistributable FFmpeg ${FFMPEG_VERSION} in ${OUTPUT_DIR}"

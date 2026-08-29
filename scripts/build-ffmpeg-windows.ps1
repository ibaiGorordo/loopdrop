[CmdletBinding()]
param(
  [string]$OutputDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ffmpegVersion = "9.0.1"
$ffmpegSha256 = "cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635"
$sourceUrl = "https://ffmpeg.org/releases/ffmpeg-$ffmpegVersion.tar.xz"
$projectDirectory = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path $projectDirectory "vendor/ffmpeg/current"
}

$cacheDirectory = Join-Path $projectDirectory "vendor/cache"
$archivePath = Join-Path $cacheDirectory "ffmpeg-$ffmpegVersion.tar.xz"
$resolvedOutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
$temporaryParent = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$buildDirectory = Join-Path $temporaryParent ("loopdrop-ffmpeg-" + [Guid]::NewGuid().ToString("N"))
$downloadPath = $null

try {
  New-Item -ItemType Directory -Force -Path $cacheDirectory, $resolvedOutputDirectory, $buildDirectory | Out-Null

  $sourceUri = [Uri]$sourceUrl
  if ($sourceUri.Scheme -ne "https") {
    throw "The FFmpeg source URL must use HTTPS."
  }

  $archiveIsValid = $false
  if (Test-Path -LiteralPath $archivePath -PathType Leaf) {
    $cachedSha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($cachedSha256 -eq $ffmpegSha256) {
      $archiveIsValid = $true
    }
    else {
      Write-Warning "Ignoring cached FFmpeg source with checksum $cachedSha256."
    }
  }

  if (-not $archiveIsValid) {
    $downloadPath = Join-Path $cacheDirectory (".ffmpeg-$ffmpegVersion-" + [Guid]::NewGuid().ToString("N") + ".download")
    $previousProgressPreference = $ProgressPreference
    $ProgressPreference = "SilentlyContinue"
    try {
      Invoke-WebRequest -Uri $sourceUrl -OutFile $downloadPath -MaximumRetryCount 3 -RetryIntervalSec 2
    }
    finally {
      $ProgressPreference = $previousProgressPreference
    }
    $downloadedSha256 = (Get-FileHash -LiteralPath $downloadPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($downloadedSha256 -ne $ffmpegSha256) {
      throw "FFmpeg source checksum mismatch. Expected $ffmpegSha256 but received $downloadedSha256."
    }
    Move-Item -LiteralPath $downloadPath -Destination $archivePath -Force
    $downloadPath = $null
  }

$bashCandidates = @()
if ($env:LOOPDROP_MSYS2_ROOT) {
  $bashCandidates += Join-Path $env:LOOPDROP_MSYS2_ROOT "usr/bin/bash.exe"
}
if ($env:RUNNER_TEMP) {
  $bashCandidates += Join-Path $env:RUNNER_TEMP "msys64/usr/bin/bash.exe"
}
$bashCandidates += "C:\msys64\usr\bin\bash.exe"
$bashCandidates += "D:\msys64\usr\bin\bash.exe"

$bashPath = $bashCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $bashPath) {
  $bashCommand = Get-Command bash.exe -ErrorAction SilentlyContinue
  if ($bashCommand) {
    $bashPath = $bashCommand.Source
  }
}
if (-not $bashPath) {
  throw "MSYS2 bash was not found. Run this script after configuring msys2/setup-msys2 with MINGW64."
}

$env:CHERE_INVOKING = "1"
$env:MSYSTEM = "MINGW64"
$env:MSYS2_PATH_TYPE = "inherit"
$env:LOOPDROP_FFMPEG_ARCHIVE = $archivePath
$env:LOOPDROP_FFMPEG_BUILD = $buildDirectory
$env:LOOPDROP_FFMPEG_OUTPUT = $resolvedOutputDirectory
$env:LOOPDROP_FFMPEG_VERSION = $ffmpegVersion
$env:LOOPDROP_FFMPEG_SOURCE_URL = $sourceUrl
$env:LOOPDROP_FFMPEG_SOURCE_SHA256 = $ffmpegSha256

$buildScript = @'
set -euo pipefail

archive="$(cygpath -u "$LOOPDROP_FFMPEG_ARCHIVE")"
build_root="$(cygpath -u "$LOOPDROP_FFMPEG_BUILD")"
output_dir="$(cygpath -u "$LOOPDROP_FFMPEG_OUTPUT")"
source_dir="$build_root/ffmpeg-$LOOPDROP_FFMPEG_VERSION"
prefix_dir="$build_root/install"

command -v gcc >/dev/null
command -v make >/dev/null
command -v nasm >/dev/null

tar -xf "$archive" -C "$build_root"
cd "$source_dir"

./configure \
  --prefix="$prefix_dir" \
  --extra-version=loopdrop \
  --disable-autodetect \
  --disable-avdevice \
  --disable-debug \
  --disable-doc \
  --disable-encoders \
  --disable-ffplay \
  --disable-gpl \
  --disable-muxers \
  --disable-network \
  --disable-nonfree \
  --disable-shared \
  --disable-version3 \
  --enable-encoder=gif \
  --enable-encoder=mpeg4 \
  --enable-ffmpeg \
  --enable-ffprobe \
  --enable-muxer=gif \
  --enable-muxer=mov \
  --enable-muxer=mp4 \
  --enable-pic \
  --enable-static \
  --extra-ldflags=-static

make -j"${NUMBER_OF_PROCESSORS:-2}"
make install

mkdir -p "$output_dir"
cp "$prefix_dir/bin/ffmpeg.exe" "$output_dir/ffmpeg.exe"
cp "$prefix_dir/bin/ffprobe.exe" "$output_dir/ffprobe.exe"
cp "$source_dir/COPYING.LGPLv2.1" "$output_dir/COPYING.LGPLv2.1"
cp "$source_dir/LICENSE.md" "$output_dir/FFMPEG-LICENSE.md"

"$prefix_dir/bin/ffmpeg.exe" -hide_banner -buildconf >"$output_dir/build-configuration.txt" 2>&1
printf '%s\n' "$LOOPDROP_FFMPEG_VERSION" >"$output_dir/version.txt"
printf '%s\n' "$LOOPDROP_FFMPEG_SOURCE_URL" >"$output_dir/source-url.txt"
printf '%s\n' "$LOOPDROP_FFMPEG_SOURCE_SHA256" >"$output_dir/source-sha256.txt"

if grep -Eq -- '--enable-(gpl|nonfree|version3)' "$output_dir/build-configuration.txt"; then
  echo "Refusing a GPL, nonfree, or version-3-only FFmpeg build." >&2
  exit 1
fi
for required_flag in \
  --disable-autodetect \
  --disable-gpl \
  --disable-network \
  --disable-nonfree \
  --disable-version3; do
  if ! grep -Fq -- "$required_flag" "$output_dir/build-configuration.txt"; then
    echo "Required FFmpeg policy flag is missing: $required_flag" >&2
    exit 1
  fi
done

filters="$("$output_dir/ffmpeg.exe" -hide_banner -filters 2>/dev/null)"
for required_filter in palettegen paletteuse scale testsrc2; do
  if ! grep -q "$required_filter" <<<"$filters"; then
    echo "Required FFmpeg filter is unavailable: $required_filter" >&2
    exit 1
  fi
done

dependencies="$(objdump -p "$output_dir/ffmpeg.exe")"
if grep -Eiq 'DLL Name:.*lib(gcc|stdc\+\+|winpthread)' <<<"$dependencies"; then
  echo "FFmpeg unexpectedly depends on a MinGW runtime DLL." >&2
  exit 1
fi

smoke_gif="$build_root/smoke.gif"
"$output_dir/ffmpeg.exe" \
  -hide_banner -loglevel error -y \
  -filter_complex 'testsrc2=size=160x90:rate=8:duration=1,split[gif][palette];[palette]palettegen=max_colors=64[paletteout];[gif][paletteout]paletteuse[out]' \
  -map '[out]' -an -loop 0 "$smoke_gif"

test -s "$smoke_gif"
case "$(head -c 6 "$smoke_gif")" in
  GIF87a|GIF89a) ;;
  *) echo "FFmpeg smoke test did not create a valid GIF." >&2; exit 1 ;;
esac
'@

  & $bashPath -lc $buildScript
  if ($LASTEXITCODE -ne 0) {
    throw "The FFmpeg Windows build failed with exit code $LASTEXITCODE."
  }
}
finally {
  if ($downloadPath -and (Test-Path -LiteralPath $downloadPath -PathType Leaf)) {
    Remove-Item -LiteralPath $downloadPath -Force
  }
  if (Test-Path -LiteralPath $buildDirectory) {
    Remove-Item -LiteralPath $buildDirectory -Recurse -Force
  }
}

Write-Host "Built redistributable FFmpeg $ffmpegVersion in $resolvedOutputDirectory"

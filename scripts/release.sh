#!/usr/bin/env bash
# Build release archives and render the Homebrew formula. Publishes nothing:
# upload the archives to a GitHub release and copy the formula to the tap yourself.
#   scripts/release.sh            # version from package.json
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(bun -e 'console.log(require("./package.json").version)')
out=release/$version
rm -rf "$out" && mkdir -p "$out"
bun test >/dev/null
for target in darwin-arm64 darwin-x64 linux-x64 linux-arm64; do
  dir=$out/plugboard-$version-$target
  mkdir -p "$dir"
  bun build --compile --minify --target=bun-$target --outfile="$dir/plugboard" src/cli.ts >/dev/null
  cp LICENSE README.md policy.example.toml "$dir/"
  tar -czf "$dir.tar.gz" -C "$out" "plugboard-$version-$target"
  rm -rf "$dir"
done
sha() { shasum -a 256 "$out/plugboard-$version-$1.tar.gz" | cut -d' ' -f1; }
sed -e "s/@VERSION@/$version/g" \
    -e "s/@SHA_DARWIN_ARM64@/$(sha darwin-arm64)/" -e "s/@SHA_DARWIN_X64@/$(sha darwin-x64)/" \
    -e "s/@SHA_LINUX_X64@/$(sha linux-x64)/" -e "s/@SHA_LINUX_ARM64@/$(sha linux-arm64)/" \
    packaging/homebrew/plugboard.rb.in > "$out/plugboard.rb"
ls -1 "$out"
echo "Next: gh release create v$version $out/*.tar.gz, then copy $out/plugboard.rb to the tap's Formula/."

#!/bin/sh
# Builds the CLI and puts it on your PATH, where `bun link` did: Bun's bin folder.
# The npm package is the library only, so it names no bin for `bun link` to use.
set -e
cd "$(dirname "$0")/.."
bun run build
bin="${BUN_INSTALL:-$HOME/.bun}/bin"
mkdir -p "$bin"
ln -sf "$PWD/dist/plugboard" "$bin/plugboard"
echo "linked $bin/plugboard -> $PWD/dist/plugboard"

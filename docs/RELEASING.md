# Releasing

plugboard ships only as compiled binaries through Homebrew ([aanduque/homebrew-tap](https://github.com/aanduque/homebrew-tap)). It is not published to npm: `package.json` stays `"private": true`.

1. Bump `version` in `package.json` and commit.
2. Run `scripts/release.sh`. It runs the tests, compiles standalone binaries (`bun build --compile`) for darwin-arm64, darwin-x64, linux-arm64 and linux-x64, packs each with LICENSE, README and `policy.example.toml`, and renders `release/<version>/plugboard.rb` from `packaging/homebrew/plugboard.rb.in`. It publishes nothing.
3. Create the GitHub release:

   ```bash
   gh release create v<version> release/<version>/*.tar.gz
   ```

4. Copy `release/<version>/plugboard.rb` to `Formula/plugboard.rb` in `aanduque/homebrew-tap`, then commit and push.
5. Check it: `brew update && brew install aanduque/tap/plugboard && plugboard --version`.

Homebrew downloads release assets without credentials, so this repository must be public, or the archives must be attached to a release in a public repository.

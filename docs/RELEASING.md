# Releasing

Plugboard ships only as compiled binaries through Homebrew ([obrier/homebrew-tap](https://github.com/obrier/homebrew-tap)). It is not published to npm: `package.json` stays `"private": true`.

## Versions

- **`version` in `package.json` is the single source of truth.** `plugboard --version` reads it, and the formula and archive names come from it.
- **Semver, staying on `0.x`** while the internal Claude Code protocol can still force breaking changes.
  - **patch:** fixes;
  - **minor:** new commands or flags, and anything that changes output or exit codes;
  - **major:** once the interface is stable.
- **The git tag is `v<version>`.** The release workflow refuses a tag that doesn't match `package.json`.

## Cutting a release

```bash
npm version patch          # or minor / major: bumps package.json, commits, and tags vX.Y.Z
git push --follow-tags
```

The tag starts [`.github/workflows/release.yml`](../.github/workflows/release.yml):
1. Check that the tag matches `package.json`.
2. Run `scripts/release.sh`:
   - run the offline tests;
   - compile the binaries with `bun build --compile` for darwin-arm64, darwin-x64, linux-arm64 and linux-x64;
   - pack each one with LICENSE, README and `policy.example.toml`;
   - render `plugboard.rb` from `packaging/homebrew/plugboard.rb.in`.
3. Create the GitHub release, with the four archives and generated notes.
4. Push `Formula/plugboard.rb` to the tap.

Step 4 authenticates with the `TAP_DEPLOY_KEY` secret: a deploy key with write access to the tap repository only. To revoke it, delete the key in the tap repo under Settings → Deploy keys. To replace it, generate a new key pair, add the public key there with write access, and run `gh secret set TAP_DEPLOY_KEY --repo obrier/plugboard < key`.

Then check it:

```bash
brew update && brew upgrade plugboard || brew install obrier/tap/plugboard
plugboard --version
```

## Dry run

To build everything without publishing, run the workflow by hand: `gh workflow run release.yml`, or **Run workflow** in the Actions tab. The archives and the formula come back as a workflow artifact named `plugboard-release`.

`scripts/release.sh` does the same locally, into `release/<version>/`.

## Landing page

`site/index.html` is the landing page: one static file, no build step. `.github/workflows/pages.yml` deploys it to GitHub Pages on every change to `site/`, but only once the repository is public. To turn it on, go to Settings → Pages → Source and choose GitHub Actions. To preview it locally, run `python3 -m http.server 4173 --directory site`.

## Before the first public release

Homebrew downloads release assets without credentials, so `obrier/plugboard` must be public, or the archives must be attached to a release in a public repository. Until then, the workflow still publishes to the tap, but `brew install` can't download the archives, and the landing page doesn't deploy.

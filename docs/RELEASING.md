# Releasing

The CLI ships as compiled binaries through Homebrew ([obrier/homebrew-tap](https://github.com/obrier/homebrew-tap)). The library ships on npm as [`@obrier/plugboard`](https://www.npmjs.com/package/@obrier/plugboard), from the same tag and version.

## Versions

- **`version` in `package.json` is the single source of truth.** `plugboard --version` reads it, and the formula and archive names come from it.
- **Semver, staying on `0.x`** while the internal Claude Code protocol can still force breaking changes.
  - **patch:** fixes;
  - **minor:** new commands or flags, and anything that changes output or exit codes;
  - **major:** once the interface is stable.
- **The git tag is `v<version>`.** The release workflow refuses a tag that doesn't match `package.json`.
- **npm never takes a version twice.** A tag publishes its version to npm for good: bump, don't re-tag.

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
3. Build the library (`bun run build:lib`) and list what npm would ship (`npm pack --dry-run`).
4. Create the GitHub release, with the four archives and generated notes.
5. Push `Formula/plugboard.rb` to the tap.
6. In a job of its own, `npm`, publish the library the first job built.

Each publishing step skips what is already done (a release that exists, a formula already in the tap, a version already on npm), so **Re-run failed jobs** finishes a release that failed part-way.

Step 5 authenticates with the `TAP_DEPLOY_KEY` secret: a deploy key with write access to the tap repository only. To revoke it, delete the key in the tap repo under Settings → Deploy keys. To replace it, generate a new key pair, add the public key there with write access, and run `gh secret set TAP_DEPLOY_KEY --repo obrier/plugboard < key`.

Step 6 stores no token. npm trusts the job through [trusted publishing](https://docs.npmjs.com/trusted-publishers): the package's settings on npmjs.com name `obrier/plugboard`, the workflow `release.yml` and the environment `npm`, and the job proves it is that workflow with a GitHub OIDC token. npm adds provenance itself. Only the `npm` job may ask for that token, and it installs and runs no dependency. npm only takes a trusted publisher for a package that exists, so a placeholder `0.0.0` was published by hand first, then deprecated.

Then check it:

```bash
brew update && brew upgrade plugboard || brew install obrier/tap/plugboard
plugboard --version
npm view @obrier/plugboard version
```

## Dry run

To build everything without publishing, run the workflow by hand: `gh workflow run release.yml`, or **Run workflow** in the Actions tab. The archives and the formula come back as a workflow artifact named `plugboard-release`, and the library as `npm-library`. The `npm` job doesn't run.

`scripts/release.sh` does the same locally, into `release/<version>/`.

## Landing page

`site/index.html` is the landing page: one static file, no build step. `.github/workflows/pages.yml` deploys it to GitHub Pages on every change to `site/`, but only once the repository is public. To turn it on, go to Settings → Pages → Source and choose GitHub Actions. To preview it locally, run `python3 -m http.server 4173 --directory site`.

## Before the first public release

Homebrew downloads release assets without credentials, so `obrier/plugboard` must be public, or the archives must be attached to a release in a public repository. Until then, the workflow still publishes to the tap, but `brew install` can't download the archives, and the landing page doesn't deploy.

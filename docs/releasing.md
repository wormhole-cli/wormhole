# Releasing

Releases are cut by pushing a `vX.Y.Z` tag. `.github/workflows/release.yml` then:
1. runs the typecheck, tests and build;
2. checks the tag matches `package.json`;
3. publishes `agent-wormhole` to npm;
4. creates the GitHub release, with that version's section of `CHANGELOG.md` as the notes.

Publishing to npm makes the code public on npmjs.com even while the GitHub repo is private. npm
provenance (the "built and signed on GitHub Actions" badge) needs a public repo, so the workflow
adds `--provenance` only once the repo is public.

## One-time setup

1. Create an npm account (or log in) and a **granular access token** with read and write access
   to packages. Limit it to `agent-wormhole` once the package exists; for the first publish it has
   to allow creating new packages.
2. Store it as a repository secret:
   ```bash
   gh secret set NPM_TOKEN --repo ashutosh091/wormhole
   ```
   Paste the token when asked. Keep a copy wherever you back up secrets.

## Each release

```bash
npm version minor            # or patch; bumps package.json, commits, tags vX.Y.Z
```

Before pushing, move the notes under `## [Unreleased]` in `CHANGELOG.md` into a new
`## [X.Y.Z] - YYYY-MM-DD` section, update the compare links at the bottom, and amend the version
commit:

```bash
git add CHANGELOG.md
git commit --amend --no-edit
git tag -f "v$(node -p "require('./package.json').version")"
git push --follow-tags
```

The workflow fails before publishing if the tag and `package.json` disagree or the changelog has
no section for the version.

## Dry run

Actions → Release → Run workflow (leave **dry-run** ticked), or:

```bash
gh workflow run release.yml -f dry-run=true
```

It runs every step with `npm publish --dry-run` and skips the GitHub release.

## Checking the package locally

```bash
npm pack --dry-run            # only bin/, dist/, README.md, LICENSE
npm pack && npm i -g ./agent-wormhole-*.tgz --prefix /tmp/wh-try && /tmp/wh-try/bin/wormhole --version
```

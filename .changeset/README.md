# Changesets

Tea Code uses the upstream Changesets version-PR and npm Trusted Publishing flow. The publishable package is `@futuretea/tea-code`, which installs the `tea-code` command. Internal workspace package versions stay at their upstream values.

## Tea Code 2.3.2 preparation

The implementation and release branch is `tea/moonshot-232`, based on `@moonshot-ai/kimi-code@2.3.2` (`b8dd3a134060c6e80ba4a1659335cd63b68483f2`). The preparation package version is `2.3.1`; `.changeset/sync-upstream-232.md` applies a patch bump to produce `2.3.2` in the version PR. Do not publish the preparation version or apply a second bump after versioning. The separate upstream changelog section preserves the original 2.3.2 release notes.

## Release workflow

1. After explicit authorization to commit and push, push the implementation and pending changeset to `tea/moonshot-232`.
2. The Release workflow creates or updates the `ci: release packages` PR from `changeset-release/tea/moonshot-232`. Manual Release runs only prepare this PR. The workflow dispatches CI for that version branch.
3. Review the generated version, changelog and CI results. Only the Tea Code package should be versioned; its package version and default Kimi client identity must both be `2.3.2`.
4. Merging the matching version PR authorizes npm publication after that exact merge commit's push CI succeeds. Ordinary pushes, unrelated PRs, failed CI and manual runs do not authorize publication.

The publisher builds the workspace and runs `pnpm changeset publish` through `.github/workflows/release.yml`. This fork's formal release does not publish the VS Code extension, deploy documentation, or build/sign/upload native release assets. Manual and local native build scripts remain available under their upstream names.

## npm Trusted Publishing

The existing trusted publisher for `@futuretea/tea-code` uses repository `futuretea/kimi-code` and workflow `release.yml`. `id-token: write` supplies npm authentication; no `NPM_TOKEN` is needed. Changes to npm's external publisher settings require separate authorization.

## User-facing changesets

Follow `.agents/skills/gen-changesets/SKILL.md`, using `@futuretea/tea-code` as the CLI package name in this distribution. Write a short English sentence describing the user-visible change. Docs-only, tests-only and internal-only changes do not need a changeset. Do not include private packages in release changesets or bump shared package versions for rebranding.

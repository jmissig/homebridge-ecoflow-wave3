# Decision 0008: One dependency updater and build-time protobuf generation

- Date: 2026-09-24
- Status: accepted
- Supersedes: generated-source tracking and drift checks in decision 0001

## Context

The custom weekly `npm update` workflow and Dependabot both proposed dependency
updates, including overlapping security fixes. The custom workflow also needed
human approval for downstream CI because it created PRs with `GITHUB_TOKEN`.
It existed in part to commit regenerated protobuf TypeScript alongside generator
updates. That bookkeeping does not need a second PR-producing system.

The official Homebridge plugin template's `latest` branch was checked on
2026-09-24: it supplies build CI but does not prescribe a dependency updater.

## Decision

- Use Dependabot as the only dependency updater. Remove the custom workflow.
- Group npm minor/patch version updates into a weekly Saturday PR. Keep major
  npm upgrades individual for deliberate review, with a limit of two open npm
  version-update PRs.
- Group GitHub Actions version updates separately, with one open version-update
  PR. Group security updates per ecosystem, separately from version updates.
  Security updates are not held for the weekly routine-update schedule.
- Keep standard read-only PR verification on Node 24 and 26. No new App
  credentials, automatic merges, releases, or live installations are introduced.
- Track the reviewed `.proto` schemas and Buf configuration, not generated
  TypeScript. `buf generate` cleans and recreates ignored `src/proto/gen/`.
- Generate before standalone builds, tests, and test type checks. Verification
  lints the schema, generates, and validates the resulting code with the rest of
  the plugin. It no longer compares generated output with Git.
- Build on `prepare` so Git installs and a fresh checkout's `npm pack` produce
  a complete package. Include compiled protobuf JavaScript, licensing, and
  attribution in the package;
  do not require generators or source schemas at runtime.

## Consequences

Dependency-only PRs no longer require a bot to commit generated files. Schema
and dependency changes are validated together from fresh generated code. A
developer gets generated editor inputs and a build automatically with `npm ci`.
Generated code remains inspectable locally, with provenance inherited from the
schema. Runtime behavior and accessory identity are unchanged.

This reduces routine noise, not every PR to one: security updates, major
upgrades, and Actions updates remain distinct reviewable changes. Merging
updates does not itself bump the plugin version or publish a release.

### Git installation follow-up (2026-09-24)

Julian requested direct `npm install -g github:jmissig/homebridge-ecoflow-wave3`
support. An isolated install with the original `prepack` hook succeeded but
omitted `dist/index.js`: npm's Git packing path runs `prepare`, not `prepack`.
Move the build hook to `prepare`. Git installs produce a packaged copy and
avoid the duplicate Matter.js runtime risk of a global checkout symlink. The
local helper remains available for verification and installation of checkout
changes; no runtime or version changes are needed.

## References

- [Homebridge plugin template](https://github.com/homebridge/homebridge-plugin-template/tree/latest)
- [Dependabot configuration](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference)
- [Dependabot and Actions](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-on-actions)
- [Security-update grouping](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-security-updates)

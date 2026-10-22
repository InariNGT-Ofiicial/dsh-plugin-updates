# Repository instructions

Ship an installable DSH bundle with ready-to-run JavaScript. Preserve automatic updates enabled by default, the 24-hour check interval, and persistent human controls. Do not silently reset existing settings or change the enabled state of updated plugins.

Use Node.js 24+. Development and offline tests require no dependency installation; semver is vendored with its MIT license. Run `npm run check`, `npm test`, inspect `npm pack`, and run `node scripts/verify-package.mjs <tarball>` before publishing. Package metadata and the version tag must agree. Keep release notes in docs/RELEASE.md current. Runtime compatibility changes require relevant real-host checks.

Keep credentials, work/, outputs/, profiles, caches, backups, real account records, installation receipts and user case data out of Git and Release assets. Public tests use synthetic fixtures. Distinguish synthetic network tests, actual installer tests, real GitHub downloads and running-plugin business validation.

Install only identified versions of already-installed plugins from their original source. Preserve source identity checks, compatibility gates, disabled lifecycle scripts, old-package snapshots, readback validation, failure records and the shared installation lock. A failed rollback must remain visible and must not be cleared automatically. Do not overwrite local development links or automatically restart DSH.

Release tags trigger the release workflow. Publish one versioned package .tgz and SHA256SUMS.txt. Stable Releases are intentional: the default checker excludes prereleases. Never replace an already-published version's assets; use a new version for corrections.

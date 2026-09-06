Review of 1440d7d; correction to completed #12.

[release.yml](https://github.com/nytafar/obsidian-herdr/blob/1440d7d9c81dabd756b92c5e73856e74a474debb/.github/workflows/release.yml#L3) triggers only on v* tags and explicitly validates `tag == v + manifest.version`. [docs/development.md](https://github.com/nytafar/obsidian-herdr/blob/1440d7d9c81dabd756b92c5e73856e74a474debb/docs/development.md#L38) documents that workflow.

AGENTS.md requires the tag to equal manifest.version without v. The [official Obsidian sample plugin](https://github.com/obsidianmd/obsidian-sample-plugin/blob/master/README.md#releasing-new-releases) likewise requires the exact version number without a prefix.

For a 0.1.0 manifest, the current pipeline publishes v0.1.0 and will not run on the required 0.1.0 tag. This is a community-release readiness defect; the live symlink install does not exercise it.

Change the trigger, tag comparison, release documentation and version-bump/tag instructions together. Inspect existing published assets/tags before deciding whether historical releases need migration; do not delete existing tags automatically.

Acceptance: a bare matching semantic version passes; prefixed/mismatched tags are rejected; versions.json matches minAppVersion; the three required assets remain individually attached.

Related CI improvement: the PR/push workflow builds and lints but never runs npm test; add the existing test suite there so failures are caught before release tagging.

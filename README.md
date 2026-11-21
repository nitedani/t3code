# carry: carried T3 nightlies

This repo is a fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) that builds its nightlies with a few PRs merged in, for nitedani's machines. `main` is upstream's `main`; open pull requests against it. This branch, `carry`, is the default branch, because GitHub runs scheduled workflows only from there. It holds this README and three workflows, nothing else:

- `.github/workflows/sync.yml` moves `main` to upstream's `main` every 3 hours, so `main` carries no commit of its own.
- `.github/workflows/carry.yml` reads the requests and plans the builds; it fetches upstream's source itself.
- `.github/workflows/key.yml` builds, attests and publishes one pick set.

## Requests

Each machine has one open issue here, opened by its own gh login (`nitedani` or `nitedani-agent`, `REQUESTERS` in carry.yml; other authors' issues are ignored). The machine keeps it in `~/.local/share/t3-carry/issue` as `nitedani/t3code#<n>`, and its dashboard is the only writer of the body: up to 20 lines, one per PR, nothing else. Anyone with write here can edit any issue, so a request whose body was last edited by anyone but its author is not built.

```
pick 31488 809f8bb59a0e2363ff284562645ba0f4cebd60c8
pick 37306 8c549d97753af96dba62219c9ae19f61ff7c3431 <res40>
pick nitedani/t3code#12 <sha40>
pick nitedani/t3code#2 <sha40> <res40>
```

The sha must be a commit of that PR; a newer push is built only once the line names it. The optional third field is a resolution (below). `nitedani/t3code#<n>` names an own PR, an open PR of this repo against `main`, for a change of our own with no upstream PR; any machine may pick any of them, and an issue with a line naming any other fork is skipped. An own PR must be open and based on `main`; when it isn't, or a pick's PR can't be read, that request is not built and its run shows an error. The key of a request, computed the same way by the machine:

```bash
picks=$(tr -d '\r' <<<"$body" | grep -E '^pick ([1-9][0-9]{0,6}|[A-Za-z0-9-]+/t3code#[1-9][0-9]{0,6}) [0-9a-f]{40}( [0-9a-f]{40})?$' | LC_ALL=C sort -k2,2n)
key=$(printf '%s\n' "$picks" | sha256sum | cut -c1-16)
```

PR order below is this sort's: own picks first, then upstream PRs by number.

## Builds

At 00:50 and 01:50 UTC and by hand (`gh workflow run carry.yml -R nitedani/t3code`), the workflow takes the newest upstream nightly `v<V>` and builds every key without a built release for it; when a requester's issue is opened, edited or reopened, only that issue's key. A key is built only when every pick applies (below): the workflow first merges them as the build would, in a blobless clone, and a key with a pick that doesn't apply is not built, since a machine installs no build that leaves a pick out; a Resolve press fixes the pick first. An issue's runs are named `carry #<issue>`, and a newer edit of the issue cancels its running or waiting run; scheduled and manual runs are named `carry #nightly` and wait for each other. It only reads issues.

Per pick, in PR order:
- When upstream merged the PR and its merge commit is in `v<V>`, the pick is `merged` and left out; removing its line is the dashboard's job. An own pick is never `merged`.
- When the sha is not a commit of the PR, it is `unpinned` and left out.
- Otherwise it is merged into the tree: its resolution if the line names one, else the sha. A pick that conflicts is `doesnt-apply` and left out; the others still go in.

Then upstream's release steps for the Linux x64 CLI archive run: install, typecheck, bundle, build and smoke test, with `dev` telemetry as upstream does outside pingdotgg. A pick merged by its resolution also runs `vp test run` on the test files its PR changes. When any step fails, the nightly alone is built, then in PR order each pick over the picks kept so far: a pick is kept when that builds, and is `doesnt-build` when it doesn't. So a resolution made over an earlier pick is built with that pick. A `doesnt-build` pick is then built over the nightly alone, and when that builds, over the first picks of the kept ones, halving the range each time, to find a run of them it fails over: its `cause` is `alone`, or the last pick of that run. When the nightly alone fails, every pick is `doesnt-build` and `recipe` is `broken`. On a night that builds, none of this runs.

The picks' code runs only in key.yml's `build` job, which holds no token that can write to this repo or sign, and uses no Actions cache; it hands the archive and each pick's state to the `publish` job, which runs no pick code. So one machine's picks can't change another machine's build or sign one.

The build gets its own version `<V'>` = `<V>.c<key>` (for example `0.1.11-nightly.20261117.4825.c32b5b524027a2d1b`), which sorts above `<V>` and below the next nightly, so it never shares an install with the official `<V>` or another pick set. The result is the prerelease `c/<key>/r<run>.<attempt>/v<V'>`, tagged on this repo's `carry`, where `<run>.<attempt>` is the run's id and attempt: releases here are immutable and a deleted release's tag name can't be used again, so every run publishes under a name of its own. A key counts as built for `v<V>` once one of its published releases has a `carry.json` that key.yml attested on `carry`, naming that release's own tag, with state `built`; a key that wasn't built is built again by the next run. Its body and its `carry.json` asset are the same JSON, schema 3, which says what the build did, not what upstream says of each PR now:

```json
{
  "schema": 3,
  "nightly": "<V>",
  "version": "<V'>",
  "state": "built",
  "recipe": "ok",
  "picks": [
    {"pr": 31488, "sha": "<sha40>", "res": null, "state": "carried", "cause": null}
  ],
  "run": "<the run's URL>",
  "tag": "c/<key>/r<run>.<attempt>/v<V'>",
  "sha256sums": "<sha256 of SHA256SUMS>"
}
```

- `state`: `built` when every pick that is neither `merged` nor `unpinned` is `carried`, and at least one is; else `not-built`, and the release holds `carry.json` alone.
- `recipe`: `ok`, or `broken` when the nightly alone fails to build with these steps.
- Each pick's `pr`: the upstream PR's number, or for an own pick the string from its line, such as `"nitedani/t3code#12"`.
- Each pick's `state`: `carried`, `doesnt-apply`, `doesnt-build`, `merged` or `unpinned`.
- `cause`: for a `doesnt-build` pick, `alone` or the `pr` of the earlier pick it fails with; else `null`, also when `recipe` is `broken`.
- `tag`: the tag of the release it is published in.
- `sha256sums`: the sha256 of that release's `SHA256SUMS`; only when `state` is `built`.

A `built` release also has `t3-<V'>-linux-x64.tar.gz` and `SHA256SUMS`. key.yml attests every file of a release before it publishes it, and the body can still be edited afterwards, so a machine reads only the `carry.json` asset, and first checks it and `SHA256SUMS` with:

```bash
gh attestation verify <file> --repo nitedani/t3code --signer-workflow nitedani/t3code/.github/workflows/key.yml --source-ref refs/heads/carry --deny-self-hosted-runners
```

T3 checks the archive against `SHA256SUMS`. The machine installs it with:

```bash
T3CODE_RELEASE_BASE_URL=https://github.com/nitedani/t3code/releases/download/c/<key>/r<run>.<attempt> t3 update --yes <V'>
```

A machine installs the newest release of its key that verifies, whatever its age, only when its `carry.json` names that release's tag and its `SHA256SUMS`, and names exactly the machine's lines with every one `carried`; otherwise, and while GitHub can't be read, it keeps what it runs until a Resolve press, so a `not-built` release is published only for its pick states and their `cause`. With no picks, the machine takes the plain nightly (`t3 update --yes --channel nightly`; T3 counts `<V'>` as stable). Each run keeps the newest two releases of each requested key and every release younger than a day, and deletes every other `c/*` release with its tag, and every draft older than a day, which a publish that failed left. Each run also re-enables carry.yml and sync.yml through GitHub's API, since GitHub disables a public repo's schedules after 60 days without activity.

## Resolve

A pick that doesn't apply or build is resolved from its machine's dashboard: one Resolve button starts a T3 thread on that machine. For an own pick that fails over the nightly alone it merges the nightly into the PR's branch, resolves it, pushes the branch and moves the line to its new head; an own pick that fails only with an earlier pick gets a resolution as below, on branch `t3-carry/<issue>/own-<n>`, so the PR itself never holds another pick's code. For our own open upstream PR it rebases the PR itself and moves the line to its new head. For any other PR it merges the sha onto the nightly (with `--no-ff`, over the earlier picks only when it conflicts with them), resolves it, pushes the commit as branch `t3-carry/<issue>/<pr>` of this repo, and adds its sha to the line. The build fetches a resolution only from this repo, and uses it only when it holds the pick and its own first-parent line starts with a merge that brings in nothing but the pick and code already in that night's tree; otherwise the pick is `doesnt-apply`. Git's three-way merge then carries the resolution onto later nightlies. The dashboard deletes a `t3-carry/<issue>/<pr>` or `t3-carry/<issue>/own-<n>` branch of its own request once no line names it.

When the nightly alone doesn't build (`recipe: broken` in carry.json, so upstream changed how it builds), no pick is at fault: a Resolve press on a machine whose login is this repo's admin (private) brings the build steps of `key.yml` in line with upstream's `release.yml` and `release-desktop.yml` at that nightly and restarts the builds. A press on any other machine leaves a note saying so.

Settings: default branch `carry`; Issues on; immutable releases on; the Environment `sync`, which only `carry` can use, holds `SYNC_TOKEN`, a fine-grained token with Contents and Workflows write on this repo; ruleset 27783201 lets only the admin push `main` and `carry`.

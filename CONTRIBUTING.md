# Contributing

Bug reports, feature requests and pull requests are all welcome. This file is
the short version of what will make any of them go smoothly.

## Reporting a bug

Open an issue at
[github.com/elliott-json-park/obsidian-download-pulse/issues](https://github.com/elliott-json-park/obsidian-download-pulse/issues).

The useful things are: your Obsidian version, desktop or mobile, the plugin
version, which plugins you follow, and what you did immediately before it
happened. If a number looks wrong, say which plugin, which day and what you
expected — and whether *Fill in past history* is on, since earlier days can
come from a third-party archive rather than the official file.

## Suggesting a feature

Say what you wanted to find out about your plugins, not only what you would
like added. Much of the dashboard came from a plugin author describing a
question they kept asking.

Two things are deliberately out of scope, so it saves time to say so:

- **Sending anything about your vault.** The plugin only makes anonymous
  `GET` requests for public data, listed in the README's *Network use* table.
  A new request needs a row in that table and a reason.
- **Private or login-only data.** Everything shown can be checked against
  public sources. The GitHub token setting is optional and only lifts
  GitHub's anonymous rate limit; no feature may require it.

## Pull requests

### Setting up

```bash
npm install
npm run dev        # rebuild main.js on change
npm run build      # type-check, then bundle main.js
npm test           # storage, analysis and the refresh engine against a fake network
npm run harness    # the real plugin in a browser page at http://localhost:5178
npx eslint .       # the same rules as Obsidian's plugin review
```

The source is TypeScript in `src/`: `data/` (fetching, storage and the
refresh engine), `analysis.ts`, `forecast.ts` and `report.ts` (the numbers and
the insight cards), `ui/` (dashboard, charts, share cards) and `i18n.ts`.

### Before you open the PR

1. **`npm test` and `npx eslint .` pass.** CI runs both on every push.
2. **You have looked at it in the harness.** `npm run harness` runs `src/`
   with live data; the README lists the query flags for opening a given page.
3. **New text exists in every language.** The interface is in English, Korean
   and Chinese; add your strings to `src/i18n.ts` for all three.
4. **Strings never become HTML.** Text markup in `src/i18n.ts` goes through
   `rich()` in `src/ui/util.ts`, which builds DOM nodes.

### Commit messages

A sentence in the imperative that says what the change does for the user:
"Show the rank change since last week on each card". Not "fix bug".

## Releases

Maintainer only. `npm version <x.y.z>` bumps `package.json`, `manifest.json`
and `versions.json` together; then `git push && git push --tags`. The workflow
in `.github/workflows/release.yml` runs ESLint and `npm test`, builds from the
tag, and mints a provenance
attestation so anyone can verify with `gh attestation verify` that the assets
were built by that workflow from this repository.

## License

By contributing you agree that your contribution is licensed under the MIT
licence, the same as the rest of the project. See [LICENSE](LICENSE).

# Development

There is no build step. The files in this folder are the extension.

## Requirements

- Node.js 20.15 or newer, with npm.
- For browser checks only: Playwright's Chromium. System Chrome and Edge removed the command-line
  flags for side-loading extensions, so the checks can't use them.

## Tests

```sh
npm ci --ignore-scripts
npm run test:public
```

`--ignore-scripts` is on purpose: none of the dev dependencies (`playwright-core`, `pngjs`,
`pixelmatch`) need install scripts, and none of them end up in the extension.

`npm test` runs the `internal` scope, which also checks the private admin build and the backend
SQL. It only works inside the main Thumb Sight repository. Here, use `test:public`. Three tests
that compare against those private parts are skipped in this scope.

## Browser checks

```sh
npx playwright-core install chromium
```

Then point `TV_CHROME` at it and run a check:

```sh
# macOS, Linux, Git Bash
TV_CHROME="$(node -e 'console.log(require("playwright-core").chromium.executablePath())')" npm run check:pub07
```

```powershell
# PowerShell
$env:TV_CHROME = (node -e "console.log(require('playwright-core').chromium.executablePath())")
npm run check:pub07
```

The pinned `playwright-core` 1.62.0 installs Chromium 151, which is what the checks pass on. Each
check copies the extension to a temporary folder with a fake config, starts a throwaway profile
and mocks YouTube, Pinterest and the backend. Your own browser profile is not touched.

| Script | What it checks |
| --- | --- |
| `check:intent` | buttons and panel on YouTube and Pinterest, and that a hostile page can't fake clicks or messages |
| `check:pub01` | translating the extension UI doesn't touch the site's DOM |
| `check:pub02` | retrying a failed save in the same panel |
| `check:pub06` | a stuck view-count snapshot doesn't hold the panel open |
| `check:pub07` | content scripts can't read the stored session |
| `check:floor -- --expect loaded\|refused` | `minimum_chrome_version` (needs Chromium 140 / 139) |
| `check:restart` | the session survives a browser restart |
| `check:artifact` | a release ZIP: set `TV_ARTIFACT` to the packager's output folder |

## Running it from source

```sh
cp config.example.js config.js     # PowerShell: Copy-Item config.example.js config.js
```

Put the public Supabase anon key in `config.js`, or copy `config.js` from a release ZIP. Never put
a `service_role` key or any other secret there: the browser reads this file. `config.js` is in
`.gitignore`.

Then open `chrome://extensions`, turn on Developer mode, click **Load unpacked** and pick this
folder. After changing code, click Reload on the extension card and reload YouTube and Pinterest
tabs.

Don't change `manifest.key`. It fixes the extension ID, and sign-in is registered for that ID.

## Release ZIP

```sh
node tools/package-release.mjs --config <path/to/config.js> --out <release-dir>
```

The packager reads the config without running it, checks that the key is a public anon key for
this project, and writes a fresh `config.js` into the ZIP. The ZIP is deterministic. Next to it
you get `.sha256`, `.provenance.json` and an `unpacked/` copy.

## Source export

This repository is exported from the main Thumb Sight repository file by file. The list is in
`tools/runtime-files.mjs`.

```sh
node tools/export-source.mjs <empty-dir>
npm run verify:sums                  # checks SHA256SUMS.txt in the current folder
```

`verify-sums` only reads files listed in `SHA256SUMS.txt`, refuses `config.js`, `.env*` and odd
paths, and fails on any mismatch.

## License

MIT, see `LICENSE`. Third-party icon notices are in `THIRD_PARTY_NOTICES.md`.

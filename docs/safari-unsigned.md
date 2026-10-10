# Safari (experimental)

There's no Apple Developer account behind this project, so there's no signed Safari build. Instead, a GitHub Actions job converts the extension with Apple's `safari-web-extension-packager` and builds an unsigned macOS app. Nobody has tried it on a Mac yet.

What's known:

- Sign-in won't work. Safari has no `identity.launchWebAuthFlow`, the extension doesn't yet know where to keep the session in Safari, and the server only accepts Chrome redirect URLs. Fixing that is a separate job.
- The build uses a fake backend key, so even without the sign-in problem nothing would save.
- What can be tested: whether Safari loads the extension, the popup, the buttons on YouTube and Pinterest, and the save panel.

## Getting the build

Actions → **Safari test build (unsigned)** → Run workflow. When it finishes, download the artifact. Inside are three ZIPs: `adhoc` (try this first), `unsigned`, and `folder` (the bare extension folder).

## Trying it on a Mac

1. Unzip `…-adhoc.zip` and remove the quarantine flag:
   ```sh
   xattr -dr com.apple.quarantine "Thumb Sight.app"
   ```
2. Open `Thumb Sight.app` once, then close it. That registers the extension.
3. In Safari: Settings → Advanced → turn on "Show features for web developers".
4. Settings → Developer → turn on "Allow unsigned extensions". Safari turns this off every time it quits.
5. Settings → Extensions → enable Thumb Sight.
6. Open youtube.com, click the Thumb Sight icon in the toolbar and allow it on the site. Reload the page.

If the extension doesn't show up, try the `unsigned` build, then Settings → Developer → "Add Temporary Extension…" with the `folder` build.

## What to send back

- Which build showed up in Settings → Extensions.
- Whether the popup opens, and the error you get when you click sign in.
- Whether the button appears on YouTube videos and Pinterest pins after allowing the site.
- Whether clicking it opens the panel, and whether thumbnails show inside it.
- Anything red in Develop → Web Extension Background Content → Thumb Sight.

# WindowFocus

A free, local Brave/Chromium extension for background lecture playback and optional next-lecture navigation. Version 0.1 targets this course only:

`https://www.coursera.org/learn/upgrading-apps-generative-ai/`

## Load in Brave

1. Download and extract this repository, or clone it. Open `brave://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select the **`extension` subfolder** inside the repository. This folder contains `manifest.json`; selecting the repository root will fail.
3. Pin **WindowFocus** from Brave's extensions menu.
4. Open its popup and enable **Background playback**. **Next lecture** is selected by default.
5. Reload an already-open lecture once, then click Play. Switch to another app to test.

The extension starts off. Settings update open course pages without a reload after installation. The toolbar shows **ON** when enabled. Disable the switch or remove the extension from Brave to stop using it.

## Behavior

- Overrides page focus/visibility checks on lecture routes while enabled, and blocks window/document focus-loss events. Form controls retain their own focus events.
- Preserves manual pause, playback speed, and seeking behavior.
- Waits for playback to end and gives native autoplay 1.5 seconds to navigate. Then recognizes either a visible next-video link or the player's **Video (duration)** preview card with its **Start** action.
- Waits up to 12 additional seconds for a delayed or disabled preview to become usable. Start actions are accepted only on video preview cards displayed within the finished video's bounds. Generic Start buttons and non-video cards are ignored.
- Attempts to start the next lecture. If browser autoplay policy prevents this, displays a message asking you to click Play.
- Uses only the `storage` permission. No cookies API, external services, analytics, payments, quiz answers, or course-completion API calls. Coursera itself continues its normal network requests.

Source is plain JavaScript without dependencies or a build step. The page can observe the modified focus behavior; this is not an undetectability guarantee or a guarantee that your course permits background playback.

## Verification

Run `node tests/playback.test.mjs` and `node tests/bridge.test.mjs` for behavioral tests using simulated document, focus, media, and navigation events. These run the actual playback and settings-bridge scripts in isolated JavaScript contexts. They do not load a real browser or use your Coursera account.

An isolated headless Brave launch was attempted, but this environment denies socket operations required during browser startup (`shutdown: Operation not permitted`). Browser loading and real window switching are therefore unverified here.

Actual logged-in DOM, platform progress, and consecutive-video playback must still be verified in your own tab. The preview-card handling follows the supplied screenshot; exact live markup, embedded cross-origin players, and differently localized controls remain unverified.

- [x] Simulated behavior tests cover settings startup/failure, manual pause, focus controls, navigation boundaries, delayed preview cards, and Start-button navigation.
- [x] JavaScript syntax and manifest resource references checked.
- [ ] Load into Brave and check that switching to another app leaves the lecture playing.
- [ ] Confirm manual pause and the off switch behave normally in the live player.
- [ ] Confirm navigation and playback across consecutive lectures, including Coursera's recorded progress.

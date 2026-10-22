# WindowFocus

A free, local Brave/Chromium extension for background lecture playback and optional next-lecture navigation. Playback applies to Coursera lecture pages across courses, tabs, and windows in the same browser profile.

## Load in Brave

1. Download and extract this repository, or clone it. Open `brave://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select the **`extension` subfolder** inside the repository. This folder contains `manifest.json`; selecting the repository root will fail.
3. Pin **WindowFocus** from Brave's extensions menu.
4. Open its popup and enable **Background playback**. **Next lecture** is selected by default.
5. Reload every already-open lecture once, then click Play in each window. Switch between windows or to another app to test.

The extension starts off. Settings update open course pages without a reload after installation. The toolbar shows **ON** when enabled. Disable the switch or remove the extension from Brave to stop using it.

### Multiple course windows

Enable **Background playback** once, then start a video in each course window. Each page handles focus and visibility independently. The extension has no active-window owner or shared playback timer. Manually pausing a video affects only that video, and auto-next uses only the course in its own tab. Separate browser profiles need their own installation and enabled setting.

## Behavior

- Overrides page focus/visibility checks on lecture routes in every matching tab while enabled, and blocks window/document focus-loss events. Form controls retain their own focus events. Quizzes, readings, and course home pages retain native behavior.
- Preserves manual pause, playback speed, and seeking behavior.
- Waits for playback to end and gives native autoplay 1.5 seconds to navigate. Then recognizes either a visible next-video link or the player's **Video (duration)** preview card with its **Start** action.
- Waits up to 12 additional seconds for a delayed or disabled preview to become usable. Start actions are accepted only on video preview cards displayed within the finished video's bounds. Generic Start buttons and non-video cards are ignored.
- Attempts to start the next lecture. If browser autoplay policy prevents this, displays a message asking you to click Play.
- Uses only the `storage` permission. No cookies API, external services, analytics, payments, quiz answers, or course-completion API calls. Coursera itself continues its normal network requests.

Source is plain JavaScript without dependencies or a build step. The page can observe the modified focus behavior; this is not an undetectability guarantee or a guarantee that your course permits background playback.

## Verification

Run `node tests/playback.test.mjs` and `node tests/bridge.test.mjs` for behavioral tests using simulated document, focus, media, and navigation events. These run the actual playback and settings-bridge scripts in isolated JavaScript contexts. They do not load a real browser or use your Coursera account.

### Optional playback check

The optional diagnostics and end-position experiment remain scoped to the original `upgrading-apps-generative-ai` course; the playback expansion does not run them in other courses. The **WindowFocus** panel in browser DevTools is idle unless you click **Record** on a configured video page. Let one short video finish at a supported speed, select whether its completion check appeared, then click **Stop** and **Select report** to copy the result. **Load Network log** can instead inspect relevant requests already retained by DevTools; this log may contain requests from earlier pages.

The report contains endpoint names, HTTP statuses, recognized video-event names, filtered body structure, and numeric/boolean progress values or numeric ranges. Saved-progress GET responses are also filtered into `response` when DevTools retains their content; an unavailable response is labeled explicitly. Unknown field values are omitted; identifying or sensitive field names are filtered. Body metadata distinguishes absent, unavailable, unparsed, and parsed payloads. Reports exclude headers, cookies, query parameters, account/item identifiers, and raw bodies. They stay in DevTools memory. The recorder does not send, alter, or replay requests. A successful HTTP response alone does not establish that completion was accepted. Multiple returned progress values are not matched to individual videos.

Run `node tests/diagnostic-report.test.mjs` and `node tests/diagnostics.test.mjs` for the report-filtering and recording-control checks.

### Experimental end position (local 0.1.5)

The live user test received an accepted request but produced neither a completion tick nor an advanced playback position after refresh. This method has failed to demonstrate completion; do not treat it as a working skip feature. The manual test remains available for diagnosis:

1. Open a configured video at 2× or slower. In the WindowFocus DevTools panel, click **Prepare test**.
2. Play until the panel detects a fresh successful progress save and says **Ready**. A mismatched video, payload, or time unit leaves the action disabled.
3. Click **Run once**. This pauses the video and sends one update using the observed request identity, with its saved position set to the current video's duration. It does not change playback speed or synthesize an ended event.
4. Refresh the page and check the site's green tick. An accepted HTTP request alone is explicitly reported as **unconfirmed** completion. Rejected requests are not retried.

The request identity and required CSRF headers are kept only in the DevTools panel's memory, excluded from reports, and never written into the source or extension storage. The regular playback controls do not run this experiment automatically.

To inspect the failed result without sending another update, keep DevTools open while refreshing the video page, then choose **Load Network log** and **Select report**. The saved-progress GET entry's `response.progress` contains the filtered returned values, if available. Do not run the experiment again for this read-only check.

Run `node tests/progress-experiment.test.mjs` and `node tests/experiment-ui.test.mjs` for request-validation, one-shot action, and result-handling checks. Browser execution here remains unverified; the reported live experiment did not complete the video.

An isolated headless Brave launch was attempted, but this environment denies socket operations required during browser startup (`shutdown: Operation not permitted`). Browser loading and real window switching are therefore unverified here.

Actual logged-in DOM, platform progress, and consecutive-video playback must still be verified in your own tab. The preview-card handling follows the supplied screenshot; exact live markup, embedded cross-origin players, and differently localized controls remain unverified.

- [x] Simulated behavior tests cover settings startup/failure, manual pause, focus controls, navigation boundaries, delayed preview cards, and Start-button navigation.
- [x] JavaScript syntax and manifest resource references checked.
- [ ] Load into Brave and check that switching to another app leaves the lecture playing.
- [ ] Confirm manual pause and the off switch behave normally in the live player.
- [ ] Confirm navigation and playback across consecutive lectures, including Coursera's recorded progress.
- [ ] Start videos in different course windows, switch between them and another app, and confirm every video's time continues advancing. Then pause one manually and confirm the others keep playing.

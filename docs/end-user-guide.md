# EyeD Extension — End-User (Participant) Guide

Welcome to EyeD! This guide walks you through using the browser extension as a study participant or individual user.

---

## Table of Contents

1. [What is EyeD?](#what-is-eyed)
2. [Installing the Extension](#installing-the-extension)
3. [Extension Overview](#extension-overview)
4. [Configuring Settings](#configuring-settings)
5. [Starting a Session](#starting-a-session)
6. [Eye Tracker Calibration](#eye-tracker-calibration)
7. [Recording a Session](#recording-a-session)
8. [Using Overlays](#using-overlays)
9. [Taking Screenshots](#taking-screenshots)
10. [Managing Sessions](#managing-sessions)
11. [Exporting Data](#exporting-data)
12. [Privacy & Data Control](#privacy--data-control)
13. [Keyboard Shortcuts](#keyboard-shortcuts)
14. [Troubleshooting](#troubleshooting)
15. [FAQ](#faq)

---

## What is EyeD?

EyeD is a Chrome browser extension that records how you interact with web pages — where you look (if an eye tracker is connected), where you click, how you scroll, and more. Researchers use this data to improve website designs.

**As a participant, you control:**
- When tracking starts and stops
- Which websites are tracked
- Whether data is uploaded or kept local
- Clearing your data at any time

---

## Installing the Extension

### From a researcher

Your researcher will provide one of:
- A `.zip` file containing the extension
- A link to the Chrome Web Store listing
- A pre-configured browser profile with the extension installed

### Manual installation (developer mode)

1. Download or clone the extension folder
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **Load unpacked**
5. Select the `extension/` folder
6. The EyeD icon appears in your toolbar

> **Tip:** Pin the extension by clicking the puzzle-piece icon in Chrome's toolbar, then clicking the pin next to EyeD.

---

## Extension Overview

Click the EyeD icon in your toolbar to open the popup. The popup has these sections:

### Header
- **Network indicator** — Green dot = connected to server, Red = disconnected, Gray = uploads disabled
- **Settings gear** — Opens the full settings page

### Status Grid
- **Session** — Current session ID (or "None")
- **Events** — Number of tracked events in the current session
- **Queue** — Events waiting to be uploaded
- **Page** — Current page interaction stats

### Collapsible Sections

The popup organizes controls into expandable sections. Click a section header to expand or collapse it:

- **Tracking Controls** — Start/stop tracking, calibrate eye tracker
- **Capture & Replay** — Take screenshots, toggle visual overlays
- **Session** — Session name, participant ID, tag management

### Footer
- **Dashboard** — Opens the researcher dashboard (if you have access)
- **Export** — Download your session data
- **Clear Data** — Remove all locally stored data

---

## Configuring Settings

Click the gear icon in the popup header (or right-click the EyeD icon → Options) to open Settings.

### Data Endpoint

| Setting | Description |
|---------|-------------|
| **Server URL** | Where data is sent (provided by your researcher) |
| **API Key** | Authentication key (provided by your researcher) |
| **Enable uploads** | Toggle automatic data upload on/off |
| **Upload interval** | How often data is sent (default: 30 seconds) |

**To connect to a study:**
1. Paste the server URL your researcher gave you
2. Paste the API key
3. Click **Test** to verify the connection
4. Click **Save Settings**

### Data Collection

Toggle which types of data are collected:

- **Core Tracking** — Gaze, mouse movement, touch, scroll
- **Interaction Events** — Clicks, hovers, dead clicks, rage clicks, form focus, text selection, navigation
- **Page Analytics** — Scroll depth, page visibility, element visibility
- **Screenshots** — Automatic captures at intervals or on specific triggers

> Your researcher may ask you to keep specific channels enabled. Only change these if instructed to do so.

### Privacy Settings

- **Strip query parameters** — Removes `?key=value` from URLs before upload
- **Strip hash/fragment** — Removes `#section` from URLs
- **Lite mode** — Only sends coordinates and timestamps, no page element details
- **Domain scope** — Restrict tracking to specific websites

### Saving Settings

Click **Save Settings** at the bottom. A confirmation message appears. Settings persist across browser restarts.

To restore defaults, click **Reset to Defaults**.

---

## Starting a Session

1. Open the EyeD popup
2. Expand the **Session** section
3. (Optional) Enter a **Session Name** — helps identify this recording later
4. (Optional) Enter your **Participant ID** — your researcher may assign one
5. Expand **Tracking Controls**
6. Click **Start Tracking**

The status grid updates to show:
- Your new session ID
- Events counting up as you browse
- Queue filling as events await upload

---

## Eye Tracker Calibration

If you have a WebGazer-compatible eye tracker or webcam-based eye tracking:

1. Expand **Tracking Controls** in the popup
2. Click **Calibrate**
3. Follow the on-screen instructions:
   - Look at each dot as it appears
   - Click on the dot while looking at it
   - Keep your head relatively still
4. Calibration completes automatically

**Tips for good calibration:**
- Ensure good, even lighting on your face
- Position your face centered in the webcam view
- Sit at a comfortable, consistent distance from the screen
- Avoid wearing reflective glasses if possible
- Recalibrate if you shift your seating position significantly

---

## Recording a Session

Once tracking starts, EyeD works in the background. Simply browse normally:

- **Navigate** between pages — EyeD tracks across page loads
- **Scroll** through content — Scroll depth milestones are recorded
- **Click** links and buttons — Click positions and targets are captured
- **Fill out forms** — Focus/blur events are tracked (form content is NOT captured)
- **Read content** — Gaze position is recorded if eye tracking is active

### What you'll see

- The EyeD icon badge may show a number (queued events)
- The status grid updates in real time when the popup is open
- If overlays are active, you'll see visual indicators on the page

### Stopping tracking

1. Open the EyeD popup
2. Expand **Tracking Controls**
3. Click **Stop Tracking**

Any remaining queued events are uploaded (if uploads are enabled).

---

## Using Overlays

Overlays show visual feedback directly on the web page. Toggle them in the **Capture & Replay** section:

### Heatmap Overlay
Shows colored regions where you've looked or clicked most. Hot spots appear in warm colors (red/yellow), less-visited areas in cool colors (blue/green).

### Scanpath Overlay
Draws lines connecting your gaze points in sequence, showing the path your eyes followed across the page. Numbered dots indicate fixation order.

### Cursor Overlay
Displays a visual indicator following your gaze position in real time. Useful for verifying that eye tracking calibration is accurate.

**Toggle any overlay** by clicking its button. Active overlays show a blue highlight. Click again to turn off.

> Overlays are local only — they don't affect what data is recorded or uploaded.

---

## Taking Screenshots

Screenshots capture the current page appearance for the researcher to correlate with your gaze data.

### Automatic screenshots
If enabled in settings, screenshots are taken:
- On page load
- At regular intervals (default: 30 seconds)
- At scroll depth milestones

### Manual screenshots
1. Open the popup
2. Expand **Capture & Replay**
3. Click **Screenshot**

Screenshots are compressed (JPEG) and uploaded with your session data. They do NOT capture browser chrome, other tabs, or anything outside the web page.

---

## Managing Sessions

### Viewing current session
The status grid shows your active session ID and event count.

### Tags
If your researcher uses tags to categorize sessions:
1. Expand the **Session** section
2. Add tags as instructed (e.g., "task-1", "mobile-test")

### Starting a new session
Stop the current session, then start tracking again. A new session ID is generated automatically.

### Session data
All session data is stored locally in the browser until uploaded. Once uploaded, the server retains the data per the researcher's retention policy.

---

## Exporting Data

To download your session data locally:

1. Open the EyeD popup
2. Click **Export** in the footer
3. Choose the format (JSON or CSV)
4. The file downloads to your default download folder

Export includes:
- All events (gaze, clicks, scrolls, etc.)
- Session metadata (timestamps, participant ID, page URLs)
- Screenshots (in JSON format, base64-encoded)

---

## Privacy & Data Control

### What is collected

| Data Type | Details |
|-----------|---------|
| Gaze coordinates | X, Y position on the page (not the screen) |
| Mouse position | Cursor coordinates |
| Clicks | Position, target element tag/class |
| Scrolls | Scroll position and depth |
| Page URLs | Which pages you visit (query params stripped by default) |
| Screenshots | Visual capture of the page content |
| Form focus | Which fields you interact with (NOT what you type) |
| Timestamps | When each event occurred |

### What is NOT collected

- Passwords or form input content
- Other browser tabs or windows
- Files on your computer
- Browser history outside the tracked session
- Audio, video, or screen content beyond the active tab
- Any data outside the browser

### Controlling your data

- **Pause uploads** — Uncheck "Enable automatic uploads" in settings
- **Restrict domains** — Use the domain scope setting to limit which sites are tracked
- **Lite mode** — Enable to send only coordinates and timestamps
- **Clear data** — Click "Clear Data" in the popup footer to delete all local data
- **Stop tracking** — Click "Stop Tracking" at any time
- **Uninstall** — Remove the extension entirely from `chrome://extensions`

### Encryption
When an API key is configured, all uploaded data is:
- Encrypted with AES-256-GCM
- Signed with HMAC-SHA256
- Sent over HTTPS

---

## Keyboard Shortcuts

Chrome extensions can have keyboard shortcuts. Check or configure them at:

`chrome://extensions/shortcuts`

Default shortcuts (if configured by your researcher):
| Shortcut | Action |
|----------|--------|
| Alt+Shift+S | Start/Stop tracking |
| Alt+Shift+C | Capture screenshot |

> Shortcuts vary by installation. Check with your researcher for the specific shortcuts configured for your study.

---

## Troubleshooting

### Extension icon is grayed out
- The extension may be disabled. Go to `chrome://extensions` and enable it.
- You may be on a Chrome internal page (`chrome://`, `chrome-extension://`) where extensions cannot run.

### "Disconnected" network status (red dot)
- Check that the server URL in settings is correct
- Click **Test** in settings to verify the connection
- The server may be temporarily unavailable — the extension queues data locally and retries

### Events are queuing but not uploading
- Check that "Enable automatic uploads" is turned on in settings
- Verify your API key is correct
- Check your internet connection
- Events will upload automatically once connectivity is restored

### Eye tracking not working
- Ensure your webcam is connected and has permission in Chrome
- Go to `chrome://settings/content/camera` and allow camera access
- Recalibrate — click **Calibrate** in Tracking Controls
- Ensure adequate lighting on your face
- Try closing other applications using the webcam

### High memory or CPU usage
- Reduce the screenshot capture frequency in settings
- Disable channels you don't need (e.g., element visibility tracking)
- Increase the upload interval to batch more events per upload
- Close and reopen the browser if usage persists

### Screenshots are blank or incorrect
- Some pages block screenshot capture (e.g., DRM-protected video)
- Try reducing the max screenshot width in settings
- Ensure the page is fully loaded before capturing

### Data not appearing in dashboard
- Confirm your API key matches the one in the dashboard
- Check that uploads are enabled and the queue is draining
- There may be a brief delay between upload and dashboard display
- Ask your researcher to verify the session appears on their end

### Extension popup won't open
- Try reloading the extension at `chrome://extensions` (click the refresh icon)
- Clear browser cache and restart Chrome
- Reinstall the extension if the issue persists

---

## FAQ

**Q: Can the extension see my passwords?**
A: No. EyeD tracks which form fields receive focus, but never reads or records the content you type.

**Q: Does it track me on all websites?**
A: By default, yes — but only while tracking is active (you must click Start). Your researcher may configure domain restrictions. You can also set your own domain whitelist/blacklist in settings.

**Q: Can I see what data was collected?**
A: Yes. Use the Export button to download your session data. You can also view real-time stats in the popup.

**Q: What happens if I lose internet?**
A: Events are stored locally in the browser and uploaded when connectivity returns. No data is lost.

**Q: Can I participate in multiple studies?**
A: Yes. Each study uses a different API key. Switch the API key in settings when moving between studies.

**Q: How do I completely remove my data?**
A: Click "Clear Data" in the popup footer, then uninstall the extension. Ask your researcher to delete your server-side data if needed.

**Q: Does the extension slow down my browsing?**
A: EyeD is designed to be lightweight. Most users don't notice any performance impact. If you do, try reducing screenshot frequency or disabling unused data channels.

**Q: Is my data encrypted?**
A: Yes, when an API key is configured. Data is encrypted with AES-256-GCM before transmission and sent over HTTPS.

**Q: Can I use the extension without a server?**
A: Yes. Leave the server URL empty and disable uploads. Data is stored locally and can be exported manually.

---

*For technical questions or issues, contact your study researcher. For extension bugs, visit the project repository.*

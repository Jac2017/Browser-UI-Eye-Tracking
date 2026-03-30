# EyeD Researcher Guide

A comprehensive guide for UX researchers using EyeD to run eye-tracking studies, analyze gaze behavior, and generate actionable insights.

---

## Table of Contents

1. [Overview](#overview)
2. [Server Setup](#server-setup)
3. [API Key Management](#api-key-management)
4. [Creating Studies](#creating-studies)
5. [Participant Setup](#participant-setup)
6. [Task Management](#task-management)
7. [Dashboard Overview](#dashboard-overview)
8. [Session Management](#session-management)
9. [Analytics Tools](#analytics-tools)
10. [Heatmap Analysis](#heatmap-analysis)
11. [Cohort Comparison](#cohort-comparison)
12. [Form Analytics](#form-analytics)
13. [Gaze Replay](#gaze-replay)
14. [Screenshot-Heatmap Overlay](#screenshot-heatmap-overlay)
15. [Time to First Fixation](#time-to-first-fixation)
16. [Data Export](#data-export)
17. [Webhooks](#webhooks)
18. [DevOps Monitoring](#devops-monitoring)
19. [API Reference](#api-reference)
20. [Troubleshooting](#troubleshooting)

---

## Overview

EyeD is a browser-based eye-tracking research platform with two components:

- **Chrome Extension** — Captures gaze data via webcam, mouse/touch movement, clicks, scrolls, form interactions, and page performance metrics from participants' browsers
- **Analytics Server** — Stores, aggregates, and visualizes collected data through a web dashboard with study management, cohort decomposition, and export capabilities

### Architecture

```
Participant's Browser          Your Server
┌──────────────────┐          ┌──────────────────┐
│  EyeD Extension  │──HTTPS──▶│  EyeD Server     │
│  - Webcam gaze   │  AES-256 │  - SQLite DB     │
│  - Mouse/touch   │  encrypted│  - Analytics     │
│  - Screenshots   │          │  - Dashboard     │
│  - Form events   │          │  - Export         │
│  - Web Vitals    │          │  - Webhooks       │
└──────────────────┘          └──────────────────┘
```

All data transmitted from the extension to the server is encrypted with AES-256-GCM using the participant's API key, and requests are signed with HMAC-SHA256.

---

## Server Setup

### Prerequisites

- Node.js 18+
- npm

### Installation

```bash
cd server
npm install
```

### Configuration

The server uses environment variables for configuration:

| Variable | Default | Description |
|---|---|---|
| `EYED_PORT` | `3200` | Server port |
| `EYED_DB` | `server/data/eyed.db` | SQLite database path |
| `EYED_MASTER_KEY` | `eyed-dev-master-key-change-me` | Master admin key (required in production) |
| `NODE_ENV` | — | Set to `production` for production mode |

### Starting the Server

**Development:**
```bash
npm run dev
```

**Production:**
```bash
EYED_MASTER_KEY=your-secure-key-here NODE_ENV=production npm start
```

The server starts on `http://localhost:3200` with:
- Dashboard: `http://localhost:3200/dashboard`
- Monitoring: `http://localhost:3200/monitoring.html`
- API: `http://localhost:3200/api/health`

### Security Notes

- In production, `EYED_MASTER_KEY` is **required** — the server will refuse to start without it
- The master key is used for API key management, study administration, task management, and monitoring endpoints
- All payloads from the extension are AES-256-GCM encrypted
- Rate limiting: 120 requests/minute per API key (configurable per key)

---

## API Key Management

API keys control access to the server. You need the master key to manage API keys.

### Creating Keys via Dashboard

1. Open the dashboard and authenticate with your master key
2. Go to the **API Keys** tab
3. Click **Generate Key**
4. Set a name, optional project name, and scope:
   - `write` — Data upload only (for participants)
   - `write,read` — Upload + dashboard access
   - `admin` — Full access
5. **Copy the key immediately** — it is only shown in full once

### Creating Keys via API

```bash
curl -X POST http://localhost:3200/api/keys \
  -H "Authorization: Bearer YOUR_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "Study Alpha - Group A", "project": "alpha", "scopes": "write"}'
```

### Key Scopes

| Scope | Can Upload | Can Read | Can Manage |
|---|---|---|---|
| `write` | Yes | No | No |
| `write,read` | Yes | Yes | No |
| `admin` | Yes | Yes | Yes |

For studies, give participants `write` keys and keep `admin` keys for yourself.

---

## Creating Studies

Studies group participants and sessions together for comparative analysis.

### Via Dashboard

1. Go to **Studies** tab
2. Click **New Study**
3. Fill in:
   - **Name** — e.g., "E-commerce Checkout Redesign"
   - **Description** — Study goals and methodology
   - **Target URLs** — One per line, the pages participants will visit
4. Click **Create**

### Via API

```bash
curl -X POST http://localhost:3200/api/studies \
  -H "Authorization: Bearer YOUR_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Checkout Flow A/B Test",
    "description": "Compare checkout v1 vs v2 completion rates",
    "targetUrls": ["/cart", "/checkout", "/confirmation"]
  }'
```

---

## Participant Setup

### Adding Participants to a Study

```bash
curl -X POST http://localhost:3200/api/studies/1/participants \
  -H "Authorization: Bearer YOUR_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "participantId": "P001",
    "groupName": "control",
    "metadata": "{\"gender\":\"female\",\"age_group\":\"25-34\",\"experience\":\"novice\"}",
    "consentGiven": true
  }'
```

Key fields:
- **participantId** — Unique identifier (can be anonymized)
- **groupName** — Used for cohort decomposition (e.g., "control", "variant-a")
- **metadata** — JSON object with arbitrary demographic fields (used for cohort analysis by gender, age, experience, etc.)
- **consentGiven** — Must be `true` for ethical compliance

### Distributing the Extension

Provide each participant with:
1. The EyeD extension (load as unpacked in `chrome://extensions`)
2. Their API key (write scope)
3. The server endpoint URL
4. Instructions to configure in the extension's Settings page

---

## Task Management

Tasks define specific activities participants should complete during a study.

### Creating Tasks

1. Go to the **Tasks** tab
2. Select your study
3. Click **New Task**
4. Fill in:
   - **Name** — e.g., "Find the return policy"
   - **Description** — What the task tests
   - **Instructions** — What to tell the participant
   - **Target URL** — Expected destination page
   - **Success Criteria** — How to determine completion
   - **Sort Order** — Task sequence number

### Task Lifecycle

Tasks go through a lifecycle managed via API:

```
POST /api/tasks/:id/start          → Creates instance (status: "in_progress")
POST /api/tasks/instances/:id/complete → Marks completed (success: true/false)
POST /api/tasks/instances/:id/abandon  → Marks abandoned
```

### Task Completion Summary

The dashboard shows per-task metrics:
- **Total attempts** — How many participants tried the task
- **Completion count** — How many finished
- **Success rate** — Percentage who completed successfully
- **Avg/Median duration** — Time spent on the task

---

## Dashboard Overview

### Authentication

When you first visit the dashboard, you'll see a login card. Enter your master key or an API key with read access.

### Tabs

| Tab | Purpose |
|---|---|
| **Overview** | Global stats, event distribution, recent sessions |
| **Sessions** | Session list with filters, tags, annotations |
| **Analytics** | All analysis tools (5 sub-panels) |
| **Studies** | Study CRUD and participant management |
| **API Keys** | Generate, activate, deactivate keys |
| **Webhooks** | Configure event notifications |
| **Tasks** | Task definition and completion tracking |
| **Forms** | Form field analytics per session |
| **Live** | Real-time event stream via WebSocket |

---

## Session Management

### Filtering Sessions

The Sessions tab provides filters:
- **Status** — Active (still recording) or Ended
- **Participant ID** — Filter by specific participant
- **Tag** — Filter by session tags
- **Search** — Name substring search
- **Study ID** — Filter by study
- **Duration range** — Min/max duration in milliseconds

Click **Apply** to filter, **Reset** to clear.

### Tags

Tags are labels you attach to sessions for organization:
- Click **Detail** on any session to open the session detail modal
- Type a tag name and click **Add**
- Click the **x** on a tag to remove it
- Filter sessions by tag in the filter panel

Example tags: `pilot`, `outlier`, `good-calibration`, `mobile-user`, `review-needed`

### Annotations

Annotations are timestamped notes attached to sessions:
- Open the session detail modal
- Enter your note, optionally add an author name, and click **Add**
- Annotations appear in chronological order
- Click **Delete** to remove an annotation

Use annotations to flag interesting behavior: "Participant hesitated at checkout CTA for 8 seconds", "Looked at logo 3 times before finding nav menu".

---

## Analytics Tools

The Analytics tab is divided into 5 sub-panels:

### Session Analysis

Select a session and choose an analysis type:

- **Full Summary** — Event counts, duration, engagement score, URL breakdown, fixation stats
- **Heatmap** — Gaze density grid visualization
- **Fixations** — Individual fixation points with coordinates, duration, point count
- **Engagement** — Score (0-100) with factor breakdown: stability, depth, breadth, revisit rate, interaction rate
- **Timeline** — Temporal gaze position chart

### Funnel & Compare

**Funnel Analysis** — Enter a sequence of URLs to see how many sessions reached each step and where drop-off occurs. Useful for checkout flows, onboarding sequences, or multi-page tasks.

**Page Comparison** — Compare gaze metrics between two pages side by side: gaze points, fixation count, avg fixation duration, engagement score, clicks, scrolls, duration.

---

## Heatmap Analysis

### URL-Level Heatmap

Aggregates gaze data for a specific URL across all sessions:

1. Go to **Analytics > Heatmaps**
2. Enter a URL (partial match, e.g., `/pricing`)
3. Optionally filter by device type (desktop/tablet/mobile)
4. Click **Generate**

The heatmap uses a **normalized 0-1 coordinate space** — data from different screen sizes is directly comparable. Blue = low attention, red = high attention.

Device breakdown shows how many gaze points came from each device category:
- Mobile: < 768px viewport width
- Tablet: 769-1024px
- Desktop: > 1024px

### Cohort Heatmap Comparison

Compare gaze patterns between participant groups:

1. Enter the target URL
2. Select the study
3. Choose the **Cohort Field**:
   - `Group Name` — Uses the participant's assigned group
   - `gender`, `age_group`, `experience` — Uses participant metadata fields
4. Optionally filter by device
5. Click **Compare Cohorts**

The result shows:
- A combined heatmap (all cohorts)
- Side-by-side per-cohort heatmaps on the same grid
- Summary table with sessions, gaze points, max density, and active cells per cohort

### Viewport Distribution

Analyzes the device landscape for a URL:
- Device category breakdown (mobile/tablet/desktop)
- Top viewport size combinations (e.g., "1920x1080" = 45 sessions)

---

## Form Analytics

Analyzes how participants interact with form fields.

### Data Collected

The extension captures (with no content/value recording for privacy):
- **Focus/blur events** — Which fields were interacted with and for how long
- **Dwell time** — Time spent in each field (focusin to focusout)
- **Value changed** — Whether the field value was modified (boolean only)
- **Abandonment** — Fields focused but left empty
- **Submission** — Total fields, filled fields, empty required fields
- **Validation errors** — Browser-reported validation messages

### Dashboard View

1. Go to the **Forms** tab
2. Select a session
3. View:
   - **Summary cards** — Total interactions, unique fields, submissions, errors
   - **Field dwell time table** — Per-field metrics with visual bars
   - **Submission log** — Each form submission with completion stats
   - **Validation errors** — Error messages by field

### Key Metrics

| Metric | What It Tells You |
|---|---|
| **Avg Dwell Time** | Fields where users hesitate or struggle |
| **Abandon Rate** | Fields causing users to give up |
| **Visits > 1** | Fields users return to (confusion, correction) |
| **Empty Required** | Required fields left blank at submission |
| **Validation Errors** | Fields with persistent validation issues |

---

## Gaze Replay

Animated playback of a participant's gaze path.

### How to Use

1. Go to **Analytics > Overlay & Replay**
2. Select a session
3. Optionally select a screenshot as background
4. Choose playback speed (0.5x to 8x)
5. Click **Play**

Controls:
- **Pause/Resume** — Toggle playback
- **Stop** — End replay and reset
- Progress bar shows elapsed time

The replay shows:
- A blue dot representing current gaze position
- A fading trail of previous positions
- Progress bar with elapsed/total time

---

## Screenshot-Heatmap Overlay

Overlays a gaze heatmap directly on a captured screenshot.

### Generating an Overlay

1. Go to **Analytics > Overlay & Replay**
2. Select a session (only sessions with screenshots appear)
3. Select a screenshot from the dropdown
4. Click **Generate Overlay**

The result shows the screenshot with a semi-transparent heatmap canvas on top, revealing exactly which parts of the page received the most visual attention.

### Visual AOI Editor

To define Areas of Interest without writing JSON:

1. Select a session and screenshot
2. Click **Draw AOIs**
3. Click and drag on the screenshot to draw rectangles
4. Name each AOI when prompted
5. Click **Copy to TTFF** to send the AOI definitions to the TTFF analysis panel

---

## Time to First Fixation

TTFF measures how long it takes participants to first fixate on a specific area of the page.

### Single Session

1. Go to **Analytics > TTFF**
2. Enter one session ID
3. Define AOIs as JSON or use the visual editor:
   ```json
   [
     {"name": "Logo", "x": 0, "y": 0, "width": 0.15, "height": 0.1},
     {"name": "CTA Button", "x": 0.3, "y": 0.7, "width": 0.4, "height": 0.1}
   ]
   ```
   All coordinates are in normalized 0-1 space.
4. Click **Analyze TTFF**

Result: Per-AOI time to first fixation, or "Miss" if the AOI was never fixated.

### Aggregate (Multiple Sessions)

Enter comma-separated session IDs to get cross-session statistics:
- **Hit Rate** — What percentage of sessions fixated on each AOI
- **Mean/Median/Min/Max TTFF** — Distribution of first fixation times
- Useful for comparing design variants: "Is the CTA noticed faster in version A?"

---

## Data Export

### Session Events

- **JSON**: `GET /api/export/events/:sessionId?format=json`
- **CSV**: `GET /api/export/events/:sessionId?format=csv`
- Optional filters: `type` (gaze, click, etc.), `limit`

### Full Study Export

`GET /api/export/study/:studyId`

Exports a single JSON file containing:
- Study metadata and configuration
- All participants
- All sessions
- All events (batched to avoid OOM, configurable limit)
- All tasks and task instances
- All session tags and annotations
- All Web Vitals events (pagePerformance, webVital)

### Dashboard Export

On the Sessions tab, use the **Export** button to download all sessions as JSON or CSV.

---

## Webhooks

Webhooks notify external systems when events occur.

### Supported Events

- `session_start` — New session created
- `session_end` — Session ended
- `batch_upload` — Event batch received

### Setup

1. Go to **Webhooks** tab
2. Click **Add Webhook**
3. Enter the URL and select events
4. Save — a **secret** is generated for signature verification

### Signature Verification

Each webhook request includes an `X-EyeD-Signature` header with an HMAC-SHA256 signature. Verify it server-side:

```javascript
const crypto = require('crypto');
const expected = crypto.createHmac('sha256', webhookSecret)
  .update(JSON.stringify(body))
  .digest('hex');
if (signature !== expected) throw new Error('Invalid signature');
```

---

## DevOps Monitoring

Access the monitoring dashboard at `/monitoring.html` (requires master key).

### Metrics

- **System** — Memory usage (heap/RSS), CPU, load averages, OS memory
- **Requests** — RPS, P50/P95/P99 latency, error rate, top routes
- **Database** — DB file size, WAL size, table row counts, screenshot disk usage

### Alerts

Default alert thresholds:
- Memory > 90% of heap
- Error rate > 10%
- P95 latency > 5 seconds
- Disk usage > 5GB
- System memory < 10% free
- Load average > 2x CPU count

Alerts auto-resolve when conditions return to normal.

---

## API Reference

All endpoints are mounted under `/api`. Authentication via `Authorization: Bearer <key>` header.

### Core Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | None | Server health check |
| `POST` | `/events` | API key | Submit encrypted event batch |
| `POST` | `/screenshots` | API key | Submit encrypted screenshot |

### Session Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/sessions` | List sessions (supports filtering) |
| `GET` | `/sessions/:id` | Get session details |
| `GET` | `/sessions/:id/summary` | Get analytics summary |
| `POST` | `/sessions/:id/tags` | Add tag |
| `DELETE` | `/sessions/:id/tags/:tag` | Remove tag |
| `GET` | `/sessions/:id/annotations` | List annotations |
| `POST` | `/sessions/:id/annotations` | Add annotation |
| `GET` | `/sessions/:id/screenshots` | List screenshots |

### Analytics Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/analytics/heatmap/:sessionId` | Session heatmap |
| `GET` | `/analytics/fixations/:sessionId` | Fixation detection |
| `GET` | `/analytics/engagement/:sessionId` | Engagement score |
| `GET` | `/analytics/timeline/:sessionId` | Gaze timeline |
| `GET` | `/analytics/overview` | Global stats |
| `POST` | `/analytics/heatmap/url` | Cross-session URL heatmap |
| `POST` | `/analytics/heatmap/cohort` | Cohort heatmap decomposition |
| `POST` | `/analytics/viewports` | Device/viewport distribution |
| `POST` | `/analytics/ttff` | Time to first fixation |
| `GET` | `/analytics/forms/:sessionId` | Form interaction analytics |
| `GET` | `/analytics/replay/:sessionId` | Gaze replay data |
| `POST` | `/analytics/funnel` | Attention funnel analysis |
| `POST` | `/analytics/compare` | Page comparison |

### Study & Task Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/studies` | Create study |
| `GET` | `/studies` | List studies |
| `POST` | `/studies/:id/participants` | Add participant |
| `POST` | `/tasks` | Create task |
| `GET` | `/tasks/study/:studyId` | List tasks |
| `GET` | `/tasks/study/:studyId/summary` | Task completion stats |
| `POST` | `/tasks/:id/start` | Start task instance |
| `POST` | `/tasks/instances/:id/complete` | Complete task |

### Export Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/export/events/:sessionId` | Export events (JSON/CSV) |
| `GET` | `/export/sessions` | Export session list |
| `GET` | `/export/study/:studyId` | Full study export |

---

## Troubleshooting

### Server won't start

- **"FATAL: EYED_MASTER_KEY required"** — Set the `EYED_MASTER_KEY` environment variable in production
- **Port in use** — Change port with `EYED_PORT=3201 npm start`
- **SQLite errors** — Ensure the `server/data/` directory exists and is writable

### Extension can't connect

- Verify the server URL uses HTTPS (required in production)
- For local development, the extension blocks private/local IPs — use the server directly or modify validation
- Check the API key is active (not deactivated) in the dashboard

### No gaze data appearing

- The participant must open the **Eye Tracker** tab first to calibrate
- The webcam must be enabled and permissions granted
- Check the popup's status grid: Tracker should show "Running", Tracking should show "Active"

### Heatmaps look wrong

- Ensure data uses normalized 0-1 coordinates (post-migration)
- If comparing across devices, use the device filter to isolate viewport categories
- Empty heatmaps may mean the URL filter doesn't match — it uses partial matching (`LIKE %url%`)

### High memory usage

- The server caps event queries at 200K-500K rows
- Study exports stream in 5K batches
- Monitor memory via the DevOps dashboard at `/monitoring.html`
- Alerts fire automatically when heap usage exceeds 90%

### Missing form/Web Vitals data

- Form analytics requires the `formFocus` channel enabled in extension settings
- Web Vitals (FCP, LCP, CLS, FID) are captured automatically but only appear as `pagePerformance` event type
- SPA navigation events require history.pushState usage (standard for React/Vue/Angular apps)

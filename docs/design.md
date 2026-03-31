# EyeD — Architecture & Design Document

Version 1.3 | March 2026

---

## 1. System Overview

EyeD is a browser-based eye-tracking and UX research platform with two main components:

1. **Chrome Extension** — Collects gaze data, interaction events, and screenshots from participants
2. **Node.js Server** — Stores, analyzes, and serves data through a dashboard and REST API

Data flows one direction: extension → server. The dashboard and API provide read/analysis access.

```
Participant Browser                         Research Server
┌──────────────────────┐                  ┌──────────────────────┐
│  Eye Tracker (webcam) │                  │  Express + SQLite    │
│         ↓             │   HTTPS/WSS     │                      │
│  Content Scripts      │ ──────────────→ │  Event Ingestion     │
│  (analytics, gaze,    │  AES-256-GCM    │  Screenshot Storage  │
│   screenshots)        │  encrypted      │  Analytics Engine    │
│         ↓             │                  │  Dashboard SPA       │
│  Service Worker       │ ←────────────── │  WebSocket Feed      │
│  (queue + upload)     │   real-time      │  Email / Onboarding  │
└──────────────────────┘                  └──────────────────────┘
```

---

## 2. Extension Architecture

### 2.1 Manifest V3 Structure

| Component | File(s) | Responsibility |
|-----------|---------|----------------|
| Service Worker | `background/service-worker.js` | Message routing, session state, storage persistence |
| Uploader | `background/uploader.js` | Queue management, encryption, batch upload |
| Content Scripts | `content/analytics.js` | Behavioral event capture (clicks, scroll, forms, dead/rage clicks) |
| | `content/content.js` | Gaze overlay rendering, heatmap/scanpath visualization |
| | `content/screenshot.js` | Viewport and full-page screenshot capture |
| | `content/video-tracker.js` | Video playback gaze correlation |
| Popup | `popup/*` | Recording controls, overlay toggles, feedback form |
| Settings | `settings/*` | Server URL, API key, data collection toggles |
| Tracker | `tracker/*` | WebGazer calibration and gaze prediction UI |

### 2.2 Data Flow Within Extension

```
Tracker Tab (webcam)
    │ gaze coordinates
    ▼
Service Worker ──→ chrome.storage.local (8MB quota)
    │                    │
    │ routes to          │ persisted every 10s
    ▼                    │
Content Scripts          │
    │ interaction events │
    ▼                    │
Uploader Queue ←─────────┘
    │
    │ batch (max 5000 events)
    │ encrypt (AES-256-GCM)
    │ sign (HMAC-SHA256)
    ▼
HTTP POST /api/events
```

### 2.3 Event Types Captured

**Core:** `gaze`
**Input:** `mouse`, `touch`, `click`, `hover`, `deadClick`, `rageClick`
**Scroll:** `scroll`, `scrollMilestone`
**Tab:** `tabFocus`, `tabBlur`, `visibilityChange`
**Form:** `formFocus`, `formBlur`, `textSelection`
**Navigation:** `navigation` (SPA history/hash changes)
**Visibility:** `elementVisibility`

### 2.4 Gaze Processing (Client-Side)

Fixation detection uses the I-DT (Identification by Dispersion Threshold) algorithm:
- Dispersion threshold: 50px
- Minimum duration: 150ms
- Sliding window with incremental min/max tracking
- Outputs centroid coordinates with start/end timestamps

### 2.5 Upload Mechanism

- Batched at configurable interval (default 30s)
- Max 5,000 events per batch, max 2MB JSON, max 10 screenshots queued
- Offline queue persisted to `chrome.storage.local` under `_eyedOfflineQueue`
- Retry: max 4 attempts
- URL sanitization: configurable query param and hash stripping

---

## 3. Server Architecture

### 3.1 Technology Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Runtime | Node.js | Non-blocking I/O for concurrent uploads |
| Framework | Express 4 | Lightweight, well-understood |
| Database | SQLite (better-sqlite3) | Zero-config, single-file, WAL mode for concurrent reads |
| Real-time | express-ws | WebSocket dashboard feed |
| Email | Nodemailer | SMTP-based participant invitations |
| Security | Helmet | HTTP security headers |

### 3.2 Module Layout

```
server/
├── index.js                 # App bootstrap, middleware, route mounting
├── config.js                # Environment-based configuration
├── models/
│   └── db.js                # Schema definition, SQLite connection
├── middleware/
│   └── auth.js              # API key + master key authentication
├── services/
│   ├── analytics.js         # Fixation detection, TTFF computation
│   ├── crypto.js            # AES-256-GCM decryption, HMAC verification
│   ├── monitor.js           # Server health metrics
│   ├── webhook.js           # Webhook dispatch with retry
│   └── ws.js                # WebSocket client management
├── routes/                  # 15 route modules (see §3.4)
└── public/                  # Dashboard SPA, onboarding page, monitoring
```

### 3.3 Database Schema (12 Tables)

```
api_keys ──────┐
               ├──→ sessions ──→ events
studies ───────┤               ──→ screenshots
  ├── tasks    │               ──→ session_tags
  │   └── task_instances       ──→ session_annotations
  ├── participants
  └── invitations
webhooks
feedback
```

**Key design decisions:**
- `events` table uses a flat schema with `x`, `y`, `page_x`, `page_y`, `scroll_x`, `scroll_y`, `viewport_width`, `viewport_height` columns for fast spatial queries without JSON parsing
- `extra` TEXT column stores type-specific data as JSON (form field names, Web Vitals metrics, etc.)
- Indexes on `(session_id, type)`, `timestamp`, and `url` for common query patterns
- WAL mode enables concurrent reads during writes
- Foreign keys enforced for referential integrity

### 3.4 Route Modules

| Route File | Prefix | Auth | Purpose |
|-----------|--------|------|---------|
| `health.js` | `/health` | None | Liveness check |
| `events.js` | `/events` | API key | Encrypted event batch ingestion |
| `sessions.js` | `/sessions` | API key | Session CRUD |
| `screenshots.js` | `/screenshots` | API key | Screenshot upload/retrieval |
| `keys.js` | `/keys` | Master | API key management |
| `studies.js` | `/studies` | Mixed | Study + participant management |
| `tasks.js` | `/tasks` | Master | Task definitions + instances |
| `analytics.js` | `/analytics` | API key | Fixation, heatmap, funnel, TTFF, replay, forms |
| `export.js` | `/export` | Mixed | Streaming JSON/CSV export |
| `webhooks.js` | `/webhooks` | Master | Webhook CRUD |
| `feedback.js` | `/feedback` | Mixed | Bug reports + triage |
| `invitations.js` | `/invitations`, `/onboard` | Mixed | Email invitations + onboarding |
| `monitor.js` | `/monitor` | Master | Server metrics |
| `websocket.js` | `/ws` | API key | Real-time event feed |
| `dashboard.js` | `/` | None | Static page serving |

---

## 4. Security Design

### 4.1 Encryption Pipeline

```
Extension (client)                         Server
┌─────────────────────┐                 ┌─────────────────────┐
│ 1. JSON.stringify()  │                 │ 5. Verify HMAC sig  │
│ 2. PBKDF2(apiKey)    │                 │ 6. PBKDF2(apiKey)   │
│    → 256-bit AES key │   HTTP POST     │    → 256-bit AES key│
│ 3. AES-256-GCM enc  │ ──────────────→ │ 7. AES-256-GCM dec  │
│ 4. HMAC-SHA256 sign  │                 │ 8. JSON.parse()     │
└─────────────────────┘                 └─────────────────────┘
```

- **Key derivation:** PBKDF2-SHA256, 100,000 iterations, static salt `eyed-upload-salt-v1`
- **IV:** 96-bit random per encryption
- **Auth tag:** 128-bit GCM tag for integrity
- **Key cache:** LRU with 30-minute TTL to avoid repeated PBKDF2

### 4.2 Authentication

Two tiers:
1. **API key** (`authenticate` middleware) — For data submission and read access. Rate-limited per key.
2. **Master key** (`masterAuth` middleware) — For admin operations (key management, study config, invitations). Set via `EYED_MASTER_KEY` env var.

Rate limiting: sliding window, configurable per-key (default 120 req/min). Stale buckets cleaned every 60s.

### 4.3 Input Validation

- Event types validated against a whitelist of 15 types
- `extra` field strings capped at 500 characters
- Email addresses validated with regex before storage
- SQL injection prevented by parameterized queries throughout
- XSS mitigated by Helmet CSP headers + `esc()` function in dashboard
- Screenshot payloads capped at 10MB

---

## 5. Analytics Engine

### 5.1 Fixation Detection (Server-Side)

Algorithm: I-DT (Identification by Dispersion Threshold)
- Window expands point-by-point, tracking incremental min/max for x and y
- Dispersion = `max(xMax - xMin, yMax - yMin)`
- Threshold: 3% of viewport dimension
- Minimum fixation duration: 100ms
- O(n) complexity via incremental tracking

### 5.2 Heatmap Aggregation

- Gaze points normalized to 0-1 coordinate space using viewport dimensions
- Aggregated across sessions by URL pattern
- Scroll position accounted for by using `page_x`/`page_y` coordinates
- Output: array of `{x, y, weight}` for client-side rendering

### 5.3 Time to First Fixation (TTFF)

- Computed per AOI (Area of Interest) defined by normalized rectangle coordinates
- For each session: find first fixation point that falls within each AOI
- Aggregate across sessions: mean, median, min, max, hit rate per AOI

### 5.4 Funnel Analysis

- Define steps as URL patterns
- Track session progression through the funnel
- Reports: conversion rate per step, drop-off points

### 5.5 Form Analytics

Parsed from `formFocus`, `formBlur`, `formSubmit`, `formError` events in the `extra` JSON column:
- Field dwell time (focusin→focusout duration)
- Abandonment detection (focus without subsequent submit)
- Submission success/failure tracking
- Validation error capture per field

---

## 6. Dashboard Design

### 6.1 Architecture

Single-page application served as static HTML + vanilla JS. No build step or framework dependency.

- Auth gate validates key against `/api/analytics/overview` before showing the app
- Tab-based navigation (11 tabs)
- Analytics tab uses sub-tab navigation (5 panels)
- Toast notification system for user feedback
- Skeleton loading states during API calls
- Modal system for detail views and forms
- WebSocket for real-time event feed

### 6.2 Tab Structure

| Tab | Functionality |
|-----|---------------|
| Overview | Summary cards, recent activity |
| Sessions | Session list with tag filtering, detail view with annotations |
| Analytics | Fixation analysis, funnel comparison, heatmaps, gaze replay, TTFF |
| Studies | Study CRUD, participant grouping |
| API Keys | Key generation, scope management |
| Webhooks | Webhook configuration |
| Tasks | Task definitions per study, instance tracking |
| Forms | Form interaction analytics per session |
| Participants | Email list management, invitation sending, onboarding tracking |
| Feedback | Bug/feature triage with batch classification |
| Live | Real-time WebSocket event feed |

### 6.3 Feedback Classification Workflow

```
Submit (extension/dashboard)
    ↓
status: new → triaged → in_progress → resolved/closed
                                     → wont_fix
                                     → duplicate

Classification axes:
  - Type: bug, feature, usability, performance, other
  - Category: tracking, calibration, overlay, export, dashboard, auth, performance, data_loss, ui, api, other
  - Priority: critical, high, medium, low
  - Assignment: free-text researcher name
  - Resolution notes: free-text
```

Batch operations allow selecting multiple items and applying status/priority/category in one action.

---

## 7. Participant Onboarding Flow

### 7.1 Researcher Workflow

```
Dashboard → Participants tab
    │
    ├── Add emails (textarea or CSV import)
    ├── Assign to study + group
    ├── Send invitations (SMTP)
    └── Track: pending → sent → opened → installed → active
```

### 7.2 Participant Flow

```
Email invitation
    ↓
/onboard?token=<48-char-hex>
    ↓
Step 1: Review consent → checkbox → POST /onboard/consent
    ↓
Step 2: Install extension (download zip or manual instructions)
    ↓
Step 3: Auto-configure (postMessage to extension) or manual copy settings
    ↓
Ready — extension submits data to server
```

### 7.3 Email System

- SMTP via Nodemailer, configured through `EYED_SMTP_*` environment variables
- Branded HTML email template with dark theme
- Unique 48-character hex token per invitation
- Reminder system: max 3 reminders, 2-day cooldown between reminders
- Auto-deactivation tracking for undeliverable addresses

---

## 8. Data Export

### 8.1 Session Export

Streaming JSON or CSV for a single session:
- All events with full coordinate data
- Screenshots (metadata or base64-encoded)
- Session metadata

### 8.2 Study Export

Streaming JSON for an entire study:
- All sessions and events
- Tasks and task instances
- Session tags and annotations
- Web Vitals events
- Participant metadata

---

## 9. Webhook System

- Webhooks fire on configurable event types (e.g., `session_end`)
- Payload signed with HMAC-SHA256 if secret configured (header: `X-EyeD-Signature`)
- 10-second timeout per delivery
- Failure counter increments on error
- Auto-deactivation after 10 consecutive failures
- `last_triggered_at` tracked for monitoring

---

## 10. DevOps Monitoring

Dedicated monitoring service (`services/monitor.js`) tracks:
- Request count and rate (per minute)
- Error count by status code
- Response time percentiles
- Active session count
- Database size
- Memory and CPU usage

Exposed via `/api/monitor/metrics` and visualized on `/monitoring.html`.

---

## 11. Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| SQLite over PostgreSQL | Zero-config deployment, single-file backup, sufficient for research-scale data (thousands of sessions, not millions) |
| WAL mode | Allows concurrent reads during event ingestion writes |
| Flat event schema | Avoids JSON parsing overhead for spatial queries; `extra` column for extensibility |
| Client-side fixation detection | Reduces upload volume — send fixations instead of raw gaze at 30fps |
| Server-side fixation detection | Enables reprocessing with different thresholds after collection |
| AES-256-GCM + PBKDF2 | Standard authenticated encryption; key derived from API key avoids key distribution problem |
| Vanilla JS dashboard | No build step, no framework lock-in, minimal deployment complexity |
| Manifest V3 | Required for Chrome extension platform going forward; service worker instead of background page |
| Nodemailer for invitations | Standard SMTP; works with Gmail, AWS SES, Mailgun, any provider |
| Token-based onboarding | Unique per-invitation; no account creation required for participants |

---

## 12. Known Limitations & Future Considerations

### Current Limitations
- SQLite limits concurrent write throughput — suitable for research scale, not production SaaS
- No user accounts — single master key for all admin operations
- No RBAC — all API keys have equivalent read access
- Screenshots stored as files on disk — no CDN/S3 integration
- Email templates are hardcoded — no customization per study
- No automated test suite

### Potential Improvements
- PostgreSQL migration for multi-server deployment
- Role-based access control (researcher, assistant, participant)
- S3/GCS screenshot storage with signed URLs
- Configurable email templates per study
- Automated browser testing with Puppeteer
- Rate limiting per IP (not just per API key)
- Data retention policies with automatic purging
- GDPR data deletion endpoint for participant self-service

---

## 13. File Inventory

### Extension (24 files)
```
manifest.json, background/service-worker.js, background/uploader.js,
content/analytics.js, content/content.js, content/content.css,
content/screenshot.js, content/video-tracker.js,
popup/popup.html, popup/popup.css, popup/popup.js,
settings/settings.html, settings/settings.css, settings/settings.js,
tracker/tracker.html, tracker/tracker.css, tracker/tracker.js,
insights/insights.html, insights/insights.css, insights/insights.js,
icons/icon16.png, icons/icon32.png, icons/icon48.png, icons/icon128.png
```

### Server (26 files)
```
index.js, config.js, models/db.js, middleware/auth.js,
services/analytics.js, services/crypto.js, services/monitor.js,
services/webhook.js, services/ws.js,
routes/analytics.js, routes/dashboard.js, routes/events.js,
routes/export.js, routes/feedback.js, routes/health.js,
routes/invitations.js, routes/keys.js, routes/monitor.js,
routes/screenshots.js, routes/sessions.js, routes/studies.js,
routes/tasks.js, routes/webhooks.js, routes/websocket.js,
public/dashboard.html, public/onboard.html, public/monitoring.html,
public/css/dashboard.css, public/js/dashboard.js,
public/eyed-extension.zip
```

### Documentation (4 files)
```
README.md, LICENSE, docs/researcher-guide.md, docs/end-user-guide.md,
docs/design.md
```

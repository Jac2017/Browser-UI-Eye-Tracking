# EyeD — Browser Eye Tracking & UX Research Platform

EyeD is a full-stack eye-tracking and behavioral analytics platform for UX research. It combines a Chrome extension for data collection with a Node.js server for storage, analysis, and participant management.

Researchers create studies, invite participants via email, and analyze gaze patterns, click behavior, scroll depth, form interactions, and page performance — all from a single dashboard.

---

## Architecture

```
┌─────────────────────────────────┐     ┌─────────────────────────────────┐
│       Chrome Extension          │     │        Node.js Server           │
│                                 │     │                                 │
│  ┌──────────┐  ┌─────────────┐  │     │  ┌──────────┐  ┌────────────┐  │
│  │ Tracker   │  │ Content     │  │HTTP │  │ Express  │  │ SQLite DB  │  │
│  │ (webcam)  │  │ Scripts     │──┼────►│  │ Routes   │  │ (WAL mode) │  │
│  └──────────┘  │ - analytics │  │     │  └──────────┘  └────────────┘  │
│                │ - screenshot │  │     │  ┌──────────┐  ┌────────────┐  │
│  ┌──────────┐  │ - video     │  │     │  │ Services │  │ Dashboard  │  │
│  │ Service   │  └─────────────┘  │     │  │ - crypto │  │   (SPA)    │  │
│  │ Worker    │                   │  WS │  │ - analytics│ └────────────┘  │
│  │ (upload)  │  ┌─────────────┐  │◄───►│  │ - webhook│  ┌────────────┐  │
│  └──────────┘  │ Popup / UI  │  │     │  │ - monitor│  │ Onboarding │  │
│                └─────────────┘  │     │  └──────────┘  └────────────┘  │
└─────────────────────────────────┘     └─────────────────────────────────┘
```

## Features

### Data Collection (Extension)
- **Eye tracking** — Webcam-based gaze prediction via TensorFlow.js + MediaPipe FaceMesh
- **Interaction events** — Clicks, mouse movement, scroll, touch, hover, text selection
- **Behavioral analytics** — Dead clicks, rage clicks, form dwell time, navigation patterns
- **Page analytics** — Scroll depth milestones, element visibility, Web Vitals (LCP, FID, CLS)
- **Screenshots** — Viewport and full-page capture at intervals or on-demand
- **Video temporal tracking** — Gaze correlation with video playback timeline
- **SPA navigation** — Tracks History API and hashchange events

### Analysis (Server)
- **Fixation detection** — Velocity-threshold algorithm for identifying gaze fixations
- **Heatmap aggregation** — URL-level heatmaps with viewport-aware normalization
- **Cohort comparison** — A/B funnel analysis between session groups
- **Time to First Fixation (TTFF)** — Per-AOI analysis across single or multiple sessions
- **Form analytics** — Field dwell time, abandonment detection, validation errors
- **Gaze replay** — Animated scanpath playback with trail visualization
- **AOI editor** — Visual area-of-interest definition with normalized coordinates

### Platform
- **Study management** — Create studies, define tasks, assign participants to groups
- **Participant onboarding** — Email invitations → consent → auto-install → auto-configure
- **Session tagging & annotations** — Categorize and annotate sessions during review
- **Feedback & bug reporting** — In-extension feedback form with dashboard triage workflow
- **Export** — JSON/CSV streaming export including tasks, tags, annotations, Web Vitals
- **Webhooks** — Notify external systems on session events
- **DevOps monitoring** — Real-time server health, request rates, error tracking
- **Real-time dashboard** — WebSocket-powered live event feed

### Security
- **AES-256-GCM encryption** — Payloads encrypted client-side before upload
- **HMAC-SHA256 signing** — Request integrity verification
- **API key authentication** — Per-key rate limiting and scope control
- **Master key separation** — Admin operations require a separate master key

---

## Quick Start

### Server

```bash
cd server
npm install

# Required in production:
export EYED_MASTER_KEY="your-secret-master-key"

# Optional:
export EYED_PORT=3200
export EYED_SMTP_HOST=smtp.gmail.com
export EYED_SMTP_USER=you@gmail.com
export EYED_SMTP_PASS=app-password
export EYED_SMTP_FROM_EMAIL=you@gmail.com
export EYED_PUBLIC_URL=https://your-server.com

node index.js
```

Dashboard: `http://localhost:3200/dashboard`
Monitor: `http://localhost:3200/monitoring.html`

### Extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select the `extension/` folder
4. Click the EyeD icon → Settings → enter server URL and API key

### First Study

1. Open the dashboard, authenticate with your master key
2. Go to **API Keys** → create a key
3. Go to **Studies** → create a study
4. Go to **Participants** → add emails → send invitations
5. Participants click the email link → consent → install → auto-configure
6. Data flows into **Sessions** and **Analytics**

---

## Project Structure

```
├── extension/                    # Chrome Extension (Manifest V3)
│   ├── manifest.json             # Extension configuration
│   ├── background/
│   │   ├── service-worker.js     # Event routing, session management
│   │   └── uploader.js           # Encrypted batch upload to server
│   ├── content/
│   │   ├── analytics.js          # Behavioral event capture
│   │   ├── content.js            # Gaze overlay rendering, DOM integration
│   │   ├── screenshot.js         # Viewport/fullpage screenshot capture
│   │   └── video-tracker.js      # Video playback gaze correlation
│   ├── popup/                    # Extension popup UI
│   ├── settings/                 # Settings page
│   ├── tracker/                  # WebGazer eye tracking UI
│   └── insights/                 # Local insights viewer
│
├── server/                       # Node.js Backend
│   ├── index.js                  # Express app setup, route mounting
│   ├── config.js                 # Environment-based configuration
│   ├── models/
│   │   └── db.js                 # SQLite schema (10 tables)
│   ├── middleware/
│   │   └── auth.js               # API key + master key authentication
│   ├── services/
│   │   ├── analytics.js          # Fixation detection, TTFF computation
│   │   ├── crypto.js             # AES-256-GCM decryption, HMAC verification
│   │   ├── monitor.js            # Server health metrics collection
│   │   ├── webhook.js            # Webhook dispatch with retry
│   │   └── ws.js                 # WebSocket client management
│   ├── routes/
│   │   ├── analytics.js          # Analysis endpoints (fixation, funnel, TTFF, replay)
│   │   ├── events.js             # Event ingestion (encrypted payloads)
│   │   ├── sessions.js           # Session CRUD
│   │   ├── screenshots.js        # Screenshot storage and retrieval
│   │   ├── studies.js            # Study management, participant grouping
│   │   ├── tasks.js              # Task definitions and instance tracking
│   │   ├── keys.js               # API key management
│   │   ├── feedback.js           # Feedback/bug report submission and triage
│   │   ├── invitations.js        # Email list management and onboarding
│   │   ├── export.js             # Streaming JSON/CSV export
│   │   ├── webhooks.js           # Webhook configuration
│   │   ├── monitor.js            # DevOps monitoring endpoints
│   │   ├── websocket.js          # Real-time WebSocket feed
│   │   ├── health.js             # Health check
│   │   └── dashboard.js          # Dashboard page serving
│   └── public/
│       ├── dashboard.html        # Main researcher dashboard
│       ├── onboard.html          # Participant onboarding flow
│       ├── monitoring.html       # DevOps monitoring page
│       ├── css/dashboard.css     # Dashboard styles
│       └── js/dashboard.js       # Dashboard client-side logic
│
├── docs/
│   ├── researcher-guide.md       # Comprehensive researcher documentation
│   └── end-user-guide.md         # Participant documentation
│
├── index.html                    # Original HUE Vision eye tracking demo
├── precision.js                  # Calibration accuracy testing
├── heatmap.js                    # Local heatmap visualization
└── README.md
```

---

## Database Schema

10 tables in SQLite (WAL mode, foreign keys enforced):

| Table | Purpose |
|-------|---------|
| `api_keys` | Authentication keys with scopes, rate limits |
| `sessions` | Recording sessions linked to studies |
| `events` | Time-series gaze/interaction data |
| `screenshots` | Captured page images |
| `studies` | Experiment definitions |
| `participants` | Study participants with consent tracking |
| `tasks` / `task_instances` | Research task definitions and per-participant attempts |
| `session_tags` / `session_annotations` | Session categorization and notes |
| `webhooks` | External notification configuration |
| `feedback` | Bug reports and feature requests with classification |
| `invitations` | Email-based participant onboarding pipeline |

---

## API Reference

All endpoints under `/api`. Authentication via `Authorization: Bearer <key>` header.

### Core Data
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/events` | API key | Ingest event batch (encrypted) |
| GET/POST | `/sessions` | API key | Session management |
| POST | `/screenshots` | API key | Upload screenshot |

### Studies & Tasks
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET/POST | `/studies` | Master | Study CRUD |
| POST | `/studies/:id/participants` | Master | Add participant |
| GET/POST | `/tasks` | Master | Task definitions |
| POST | `/tasks/:id/instances` | API key | Record task attempt |

### Analytics
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/analytics/overview` | API key | Dashboard summary |
| POST | `/analytics/fixations` | API key | Fixation detection |
| POST | `/analytics/heatmap` | API key | Heatmap generation |
| POST | `/analytics/funnel` | API key | Funnel analysis |
| POST | `/analytics/compare` | API key | Cohort comparison |
| POST | `/analytics/ttff` | API key | Time to first fixation |
| GET | `/analytics/forms/:sessionId` | API key | Form interaction analysis |
| GET | `/analytics/replay/:sessionId` | API key | Gaze replay data |

### Participant Management
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET/POST | `/invitations` | Master | Email list management |
| POST | `/invitations/send` | Master | Send invitation emails |
| POST | `/invitations/send-reminder` | Master | Send follow-up reminders |
| POST | `/invitations/import-csv` | Master | Bulk import from CSV |
| POST | `/invitations/test-smtp` | Master | Verify SMTP configuration |
| GET | `/onboard/validate` | Public | Validate invitation token |
| POST | `/onboard/consent` | Public | Record participant consent |
| POST | `/onboard/installed` | Public | Mark extension installed |

### Feedback
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/feedback` | API key | Submit feedback/bug |
| GET | `/feedback` | Master | List/filter feedback |
| PATCH | `/feedback/:id` | Master | Classify and update |
| POST | `/feedback/batch-classify` | Master | Batch classification |

### System
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/health` | None | Health check |
| GET/POST | `/keys` | Master | API key management |
| GET/POST | `/webhooks` | Master | Webhook configuration |
| GET | `/export/sessions/:id` | API key | Export session data |
| GET | `/export/study/:id` | Master | Export full study data |
| GET | `/monitor/metrics` | Master | Server health metrics |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `EYED_PORT` | `3200` | Server port |
| `EYED_DB` | `./data/eyed.db` | SQLite database path |
| `EYED_MASTER_KEY` | (dev key) | Master admin key (**required in production**) |
| `EYED_SMTP_HOST` | — | SMTP server hostname |
| `EYED_SMTP_PORT` | `587` | SMTP port |
| `EYED_SMTP_SECURE` | `false` | Use TLS |
| `EYED_SMTP_USER` | — | SMTP username |
| `EYED_SMTP_PASS` | — | SMTP password |
| `EYED_SMTP_FROM_NAME` | `EyeD Research` | Email sender name |
| `EYED_SMTP_FROM_EMAIL` | — | Email sender address |
| `EYED_PUBLIC_URL` | `http://localhost:3200` | Public URL for invitation links |

---

## Keyboard Shortcuts (Extension)

| Shortcut | Action |
|----------|--------|
| `Alt+Shift+R` | Toggle recording |
| `Alt+Shift+H` | Toggle heatmap overlay |
| `Alt+Shift+S` | Take screenshot |

---

## Documentation

- **[Researcher Guide](docs/researcher-guide.md)** — Server setup, dashboard usage, analytics tools, full API reference
- **[End-User Guide](docs/end-user-guide.md)** — Installation, settings, session recording, privacy controls

---

## Technology Stack

| Component | Technology |
|-----------|-----------|
| Eye tracking | TensorFlow.js, MediaPipe FaceMesh |
| Extension | Chrome Manifest V3, Service Worker |
| Server | Node.js, Express |
| Database | SQLite (better-sqlite3, WAL mode) |
| Real-time | WebSocket (express-ws) |
| Email | Nodemailer |
| Encryption | AES-256-GCM, HMAC-SHA256 (native crypto) |
| Security | Helmet, API key auth, rate limiting |

---

## License

See [LICENSE](LICENSE) for details.

## Credits

Originally inspired by [HUE Vision](https://simplysuvi.com/hue-vision/) — browser-based eye tracking with TensorFlow.js and MediaPipe FaceMesh.

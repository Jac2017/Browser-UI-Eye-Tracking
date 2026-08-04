### **HUE Vision: Browser-Based Eye Tracking with TensorFlow.js and MediaPipe FaceMesh**

**HUE Vision** is a web-based application that brings real-time eye tracking and gaze prediction directly into the browser - powered by **TensorFlow.js** and **MediaPipe FaceMesh**.
It showcases how on-device computer vision and machine learning can work seamlessly together for intuitive, privacy-friendly gaze interaction.

---

**Demo**: https://simplysuvi.com/hue-vision/

**Post**: https://blog.roboflow.com/build-eye-tracking-in-browser/

---

#### **Features**

* Real-time eye tracking using webcam input
* Lightweight facial landmark detection via **MediaPipe FaceMesh** (replacing clmtrackr)
* On-device machine learning model for gaze prediction using **TensorFlow.js**
* Live heatmap visualization to evaluate gaze prediction accuracy
* Clean, modern overlay with subtle facial mesh rendering and eye focus tracking
* Fully privacy-preserving - no data leaves your browser

---

#### **Technologies Used**

* **JavaScript** (ES6)
* **TensorFlow.js**
* **MediaPipe FaceMesh**
* **HTML5 / CSS3**
* **jQuery**

---

#### **How to Use**

1. Allow webcam access and center your face within the frame.
2. Start the **Calibration** process to map gaze positions.
3. Begin **Training** — the model learns your eye-to-screen relationship.
4. Once trained, enable **Tracking** to predict gaze movement in real time.
5. View the **Heatmap** to visualize gaze concentration and model accuracy.

---

#### **Recent Updates**

* Switched from **clmtrackr** to **MediaPipe FaceMesh** for improved accuracy and stability
* Added **subtle mesh visualization** for cleaner UI with highlighted eye contours
* Removed legacy bounding box visuals and retuned the eye crop for precise focus
* Refined **UI design**, rendering performance, and color balance for a smoother experience

---

* Inspired by next-generation spatial and gaze tracking systems like **Apple Vision Pro**
* Built using **TensorFlow.js** and **MediaPipe** for real-time, on-device vision inference

---

### MCP Server

The `mcp-server/` directory provides a [Model Context Protocol](https://modelcontextprotocol.io/) server that gives AI assistants read-only access to collected eye-tracking data and analytics.

#### Setup

```bash
cd mcp-server
npm install
```

#### Claude Desktop / Claude Code Configuration

Add to your MCP settings:

```json
{
  "mcpServers": {
    "eyed": {
      "command": "node",
      "args": ["/path/to/Browser-UI-Eye-Tracking/mcp-server/index.js"],
      "env": {
        "EYED_DB": "/path/to/Browser-UI-Eye-Tracking/server/data/eyed.db"
      }
    }
  }
}
```

The `EYED_DB` environment variable is optional — it defaults to `server/data/eyed.db` relative to the project root.

#### Available Tools

| Tool | Description |
|------|-------------|
| `get_overview` | Global stats: sessions, events, screenshots, event type breakdown |
| `list_sessions` | List/filter sessions by status, participant, study, tags |
| `get_session` | Session details with tags and annotations |
| `get_session_summary` | Full analytics summary: fixations, engagement, heatmap, URLs |
| `query_events` | Query raw events with type/URL filters |
| `get_heatmap` | Session heatmap as a normalized grid |
| `get_fixations` | Fixation detection via I-DT algorithm |
| `get_engagement` | Engagement scoring (0-100) |
| `get_gaze_timeline` | Time-bucketed gaze position timeline |
| `list_studies` | List research studies |
| `get_study` | Study details with participants and tasks |
| `analyze_funnel` | Attention funnel analysis across URL sequences |
| `compare_pages` | Side-by-side page comparison metrics |
| `get_url_heatmap` | Cross-session heatmap aggregation per URL |
| `get_form_analytics` | Form field dwell times, abandon rates, errors |
| `get_viewport_distribution` | Device and viewport size breakdown |
| `get_time_to_first_fixation` | TTFF for areas of interest (single or aggregate) |
| `export_session_events` | Bulk event export for external analysis |

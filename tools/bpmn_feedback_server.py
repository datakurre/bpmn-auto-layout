#!/usr/bin/env python3
"""Browser UI for the file-backed BPMN layout iteration protocol.

Serves a single-page application that lets a human reviewer:
- Browse all generated reports under .bpmn-feedback/reports/
- Compare original vs transformed diagrams side-by-side
- View candidate quality-gate badges
- Review agent-proposed candidates (A / B / C / D)
- Open diagrams full-screen for visual comparison
- Monitor agent state in real time over WebSocket

The agent publishes state through one workspace-local JSON file:
  .bpmn-feedback/agent/state.json   – agent writes, UI reads
"""
from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import html
import json
import os
import re
import subprocess
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

ROOT = Path.cwd()
PROTOCOL_ROOT = ROOT / ".bpmn-feedback" / "agent"
STATE_PATH = PROTOCOL_ROOT / "state.json"
REPORT_ROOT = ROOT / ".bpmn-feedback" / "reports"
FIXTURE_ROOT = ROOT / "fixtures" / "bpmn-feedback"
REPORT_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def now() -> str:
    return dt.datetime.now(dt.UTC).replace(microsecond=0).isoformat()


# ---------------------------------------------------------------------------
# Report discovery
# ---------------------------------------------------------------------------

def report_url(value: object) -> str | None:
    if not isinstance(value, (str, Path)):
        return None
    if isinstance(value, str) and value.startswith("/reports/"):
        return value
    path = Path(value)
    if not path.is_absolute():
        path = ROOT / path
    try:
        relative = path.resolve().relative_to(REPORT_ROOT.resolve())
    except ValueError:
        return None
    return f"/reports/{relative.as_posix()}"


def report_image(report: object, part: object = None) -> str | None:
    if not isinstance(report, (str, Path)):
        return None
    path = Path(report)
    if not path.is_absolute():
        path = ROOT / path
    if path.is_dir():
        path /= "index.html"
    metrics_path = path.parent / "metrics.json"
    if not metrics_path.is_file():
        return None
    try:
        entries = json.loads(metrics_path.read_text(encoding="utf8")).get(
            "entries", []
        )
    except json.JSONDecodeError:
        return None
    if part:
        entries = [entry for entry in entries if entry.get("directory") == part]
    elif entries:
        entries = entries[:1]
    if len(entries) != 1:
        return None
    return report_url(
        path.parent / str(entries[0].get("transformed_svg", ""))
    )


def list_reports() -> list[dict[str, object]]:
    """Return metadata for every report, newest first."""
    if not REPORT_ROOT.is_dir():
        return []
    results: list[dict[str, object]] = []
    for index_html in sorted(
        REPORT_ROOT.glob("report-*/index.html"), reverse=True
    ):
        report_dir = index_html.parent
        metrics_path = report_dir / "metrics.json"
        entry_count = 0
        titles: list[str] = []
        if metrics_path.is_file():
            try:
                doc = json.loads(metrics_path.read_text(encoding="utf8"))
                entries = doc.get("entries", [])
                entry_count = len(entries)
                titles = [e.get("title", "") for e in entries]
            except json.JSONDecodeError:
                pass
        results.append(
            {
                "id": report_dir.name,
                "path": str(report_dir),
                "url": f"/reports/{report_dir.name}/index.html",
                "diagrams": entry_count,
                "titles": titles,
                "mtime": report_dir.stat().st_mtime,
            }
        )
    results.sort(key=lambda r: r["mtime"], reverse=True)  # type: ignore[arg-type]
    return results


def load_metrics(report_id: str) -> dict[str, object] | None:
    if not REPORT_ID_RE.fullmatch(report_id):
        return None
    metrics_path = REPORT_ROOT / report_id / "metrics.json"
    if not metrics_path.is_file():
        return None
    try:
        return json.loads(metrics_path.read_text(encoding="utf8"))  # type: ignore[return-value]
    except json.JSONDecodeError:
        return None


def update_fixtures() -> list[dict[str, str]]:
    """Lay out every current feedback fixture and render it for the UI."""
    fixtures = sorted(FIXTURE_ROOT.rglob("*.bpmn"))
    if not fixtures:
        raise HTTPException(
            status_code=404,
            detail=f"No BPMN fixtures found under {FIXTURE_ROOT}",
        )

    run_dir = REPORT_ROOT / f"fixture-update-{uuid.uuid4().hex}"
    run_dir.mkdir(parents=True)
    results: list[dict[str, str]] = []
    for index, fixture in enumerate(fixtures, start=1):
        try:
            subprocess.run(
                ["bpmn-auto-layout", str(fixture)],
                check=True,
                capture_output=True,
                text=True,
            )
            image = run_dir / f"{index:03d}-{fixture.stem}.svg"
            subprocess.run(
                ["bpmn-to-image", str(fixture), str(image)],
                check=True,
                capture_output=True,
                text=True,
            )
        except FileNotFoundError as error:
            raise HTTPException(
                status_code=503,
                detail=f"Required fixture command is unavailable: {error.filename}",
            ) from error
        except subprocess.CalledProcessError as error:
            output = (error.stderr or error.stdout or "").strip()
            raise HTTPException(
                status_code=502,
                detail=f"{error.args[0][0]} failed for {fixture.name}: {output}",
            ) from error

        relative = fixture.relative_to(ROOT).as_posix()
        image_url = report_url(image)
        if image_url is None:
            raise HTTPException(
                status_code=500,
                detail=f"Rendered fixture is outside the report directory: {image}",
            )
        results.append(
            {
                "name": fixture.name,
                "path": relative,
                "image_url": image_url,
            }
        )
    return results


# ---------------------------------------------------------------------------
# Quality gate (mirrors bpmn_feedback.py check logic)
# ---------------------------------------------------------------------------

GATE_METRICS = (
    "edge_crossings",
    "edge_shape_intersections",
    "non_orthogonal_segments",
    "label_overlaps",
)


def quality_gate(metrics_doc: dict[str, object]) -> list[dict[str, str]]:
    """Return a list of {title, metric, value} failures."""
    failures: list[dict[str, str]] = []
    for entry in metrics_doc.get("entries", []):  # type: ignore[union-attr]
        title = entry.get("title", entry.get("source", "diagram"))
        layout = entry.get("transformed_metrics", {}).get("layout", {})
        for metric in GATE_METRICS:
            value = layout.get(metric, 0)
            if value > 0:
                failures.append(
                    {"title": title, "metric": metric, "value": str(value)}
                )
        missing = layout.get("named_label_coverage", {}).get("missing", 0)
        if missing > 0:
            failures.append(
                {
                    "title": title,
                    "metric": "missing_named_labels",
                    "value": str(missing),
                }
            )
    return failures


# ---------------------------------------------------------------------------
# Agent state / request protocol
# ---------------------------------------------------------------------------


def normalize_state(document: dict[str, object]) -> dict[str, object]:
    normalized = dict(document)
    candidates = normalized.get("candidates")
    if isinstance(candidates, list):
        normalized_candidates = []
        for candidate in candidates:
            if not isinstance(candidate, dict):
                continue
            item = dict(candidate)
            report = item.get("report") or item.get("path") or item.get("url")
            item.setdefault("url", report_url(report))
            item.setdefault(
                "image_url",
                report_url(item.get("image") or item.get("transformed_svg")),
            )
            if not item.get("image_url"):
                item["image_url"] = report_image(report, item.get("part"))
            images = item.get("images")
            if isinstance(images, list):
                item["images"] = [
                    url for image in images
                    if (url := report_url(image)) is not None
                ]
            elif item.get("image_url"):
                item["images"] = [item["image_url"]]
            normalized_candidates.append(item)
        normalized["candidates"] = normalized_candidates
    return normalized


def default_state() -> dict[str, object]:
    return {
        "schema": "bpmn-layout-agent-state/v1",
        "phase": "idle",
        "message": "Waiting for the layout agent.",
        "updated_at": now(),
    }


def load_state() -> dict[str, object]:
    if not STATE_PATH.is_file():
        return default_state()
    try:
        return normalize_state(
            json.loads(STATE_PATH.read_text(encoding="utf8"))
        )
    except json.JSONDecodeError as error:
        raise HTTPException(
            status_code=503, detail="Agent state is being updated"
        ) from error


# ---------------------------------------------------------------------------
# FastAPI application
# ---------------------------------------------------------------------------

app = FastAPI(title="BPMN layout iteration")
REPORT_ROOT.mkdir(parents=True, exist_ok=True)
app.mount("/reports", StaticFiles(directory=REPORT_ROOT), name="reports")


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    return INDEX_HTML


@app.get("/api/state")
def api_state() -> dict[str, object]:
    return load_state()


@app.post("/api/fixtures/update")
def api_update_fixtures() -> dict[str, object]:
    fixtures = update_fixtures()
    return {"fixtures": fixtures}


@app.get("/fixtures", response_class=HTMLResponse)
def fixtures() -> str:
    return build_fixtures_html(update_fixtures())


@app.websocket("/ws")
async def websocket(websocket: WebSocket) -> None:
    await websocket.accept()
    last_state: str | None = None
    try:
        while True:
            state_text = (
                STATE_PATH.read_text(encoding="utf8")
                if STATE_PATH.is_file()
                else ""
            )
            current_state = state_text
            if current_state != last_state:
                await websocket.send_json(load_state())
                last_state = current_state
            await asyncio.sleep(0.5)
    except WebSocketDisconnect:
        return


# ---------------------------------------------------------------------------
# Metric helpers for the review page
# ---------------------------------------------------------------------------

METRIC_PATHS: list[tuple[str, tuple[str, ...]]] = [
    ("shapes", ("layout", "shapes")),
    ("edges", ("layout", "edges")),
    ("labels", ("layout", "labels")),
    ("shape overlaps", ("layout", "shape_overlaps")),
    ("label overlaps", ("layout", "label_overlaps")),
    ("edge crossings", ("layout", "edge_crossings")),
    ("edge / shape intersections", ("layout", "edge_shape_intersections")),
    ("non-orthogonal segments", ("layout", "non_orthogonal_segments")),
    ("total bends", ("layout", "total_bends")),
    ("total Manhattan length", ("layout", "total_manhattan_length")),
    ("grid center-x avg dev", ("layout", "grid_center_x_deviation_avg")),
    ("event label gap avg", ("layout", "node_label_gap", "event", "avg")),
    ("gateway label gap avg", ("layout", "node_label_gap", "gateway", "avg")),
    ("missing named labels", ("layout", "named_label_coverage", "missing")),
]

# Metrics where higher is worse (should be zero ideally)
BAD_IF_POSITIVE = {
    "shape overlaps",
    "label overlaps",
    "edge crossings",
    "edge / shape intersections",
    "non-orthogonal segments",
    "missing named labels",
}


def _get(doc: dict, path: tuple[str, ...]) -> object:
    current: object = doc
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)  # type: ignore[union-attr]
    return current


def metric_rows_html(original: dict, transformed: dict) -> str:
    rows: list[str] = []
    for label, path in METRIC_PATHS:
        before = _get(original, path)
        after = _get(transformed, path)
        # delta display
        delta_html = ""
        if isinstance(before, (int, float)) and isinstance(after, (int, float)):
            diff = after - before
            if diff > 0:
                color = "#cf222e" if label in BAD_IF_POSITIVE else "#1f2328"
                delta_html = f'<span style="color:{color}">+{diff:g}</span>'
            elif diff < 0:
                color = "#1a7f37" if label in BAD_IF_POSITIVE else "#1f2328"
                delta_html = f'<span style="color:{color}">{diff:g}</span>'
            else:
                delta_html = '<span style="color:#656d76">=</span>'
        # cell coloring for bad metrics
        after_style = ""
        if label in BAD_IF_POSITIVE and isinstance(after, (int, float)) and after > 0:
            after_style = ' style="color:#cf222e;font-weight:600"'

        rows.append(
            f"<tr><th>{html.escape(label)}</th>"
            f"<td>{html.escape(str(before))}</td>"
            f"<td{after_style}>{html.escape(str(after))}</td>"
            f"<td>{delta_html}</td></tr>"
        )
    return "\n".join(rows)


# ---------------------------------------------------------------------------
# HTML pages
# ---------------------------------------------------------------------------


def build_fixtures_html(fixtures: list[dict[str, str]]) -> str:
    sections = []
    for index, fixture in enumerate(fixtures, start=1):
        title = html.escape(fixture["name"])
        path = html.escape(fixture["path"])
        image_url = html.escape(fixture["image_url"])
        sections.append(
            f"""
<section class="fixture" id="fixture-{index}">
  <h2>{index}. {title}</h2>
  <p class="source-path">{path}</p>
  <img src="{image_url}" alt="Updated layout for {title}">
</section>"""
        )
    return FIXTURES_HTML.replace("{{FIXTURES}}", "".join(sections))


def build_review_html(report_id: str, metrics_doc: dict[str, object]) -> str:
    """Build a full review page for a report with side-by-side comparison."""
    entries = metrics_doc.get("entries", [])
    gate_failures = quality_gate(metrics_doc)

    # Quality gate banner
    if gate_failures:
        gate_items = "".join(
            f"<li>{html.escape(f['title'])}: {html.escape(f['metric'])}={html.escape(f['value'])}</li>"
            for f in gate_failures
        )
        gate_html = f'<div class="gate gate-fail"><strong>⚠ Quality gate failed</strong><ul>{gate_items}</ul></div>'
    else:
        gate_html = '<div class="gate gate-pass"><strong>✓ Quality gate passed</strong> — no crossings, overlaps, non-orthogonal segments, or missing labels</div>'

    # Per-entry sections
    sections: list[str] = []
    for entry in entries:
        title = html.escape(str(entry.get("title", "")))
        source = html.escape(str(entry.get("source", "")))
        directory = entry.get("directory", "")
        original_svg = f"/reports/{report_id}/{entry.get('original_svg', '')}"
        transformed_svg = f"/reports/{report_id}/{entry.get('transformed_svg', '')}"
        original_metrics = entry.get("original_metrics", {})
        transformed_metrics = entry.get("transformed_metrics", {})
        rows = metric_rows_html(original_metrics, transformed_metrics)

        sections.append(f"""
<section class="part" id="{html.escape(directory)}">
  <h2>{title}</h2>
  <p class="source-path"><strong>Source:</strong> {source}</p>
  <div class="comparison">
    <figure>
      <figcaption>Original</figcaption>
      <div class="img-scroll"><img src="{original_svg}" alt="Original: {title}"></div>
    </figure>
    <figure>
      <figcaption>Transformed</figcaption>
      <div class="img-scroll"><img src="{transformed_svg}" alt="Transformed: {title}"></div>
    </figure>
  </div>
  <details open>
    <summary>Deterministic metrics</summary>
    <table>
      <thead><tr><th>Metric</th><th>Original</th><th>Transformed</th><th>Δ</th></tr></thead>
      <tbody>{rows}</tbody>
    </table>
  </details>
</section>""")

    return REVIEW_HTML.replace("{{REPORT_ID}}", html.escape(report_id)).replace(
        "{{GATE}}", gate_html
    ).replace("{{SECTIONS}}", "".join(sections))


# -- Index (dashboard + agent interaction) --------------------------------

INDEX_HTML = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>BPMN layout iteration</title>
<style>
:root {
  --bg: #ffffff; --fg: #1f2328; --border: #d0d7de; --muted: #656d76;
  --blue: #0969da; --green: #1a7f37; --red: #cf222e; --yellow: #9a6700;
  --code-bg: #f6f8fa; --surface: #f6f8fa;
  color-scheme: light dark; font: 16px/1.5 system-ui, -apple-system, sans-serif;
}
@media(prefers-color-scheme:dark){:root{
  --bg:#0d1117;--fg:#e6edf3;--border:#30363d;--muted:#8b949e;
  --blue:#58a6ff;--green:#3fb950;--red:#f85149;--yellow:#d29922;
  --code-bg:#161b22;--surface:#161b22;
}}
*,*::before,*::after{box-sizing:border-box}
body{max-width:1200px;margin:0 auto;padding:1.5rem;color:var(--fg);background:var(--bg)}
a{color:var(--blue)}
h1{margin:0 0 .5rem;font-size:1.5rem}
h2{font-size:1.2rem;margin:1.5rem 0 .5rem}
h3{font-size:1rem;margin:1rem 0 .4rem}

/* Agent state banner */
.agent-banner{padding:1rem 1.25rem;border:1px solid var(--border);border-radius:8px;margin-bottom:1.5rem;background:var(--surface)}
.agent-banner .phase{font-weight:600;text-transform:capitalize}
.agent-banner .message{margin:.4rem 0 0;color:var(--muted)}

/* Buttons and forms */
button,textarea,select,input[type="text"]{font:inherit;padding:.5rem .75rem;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg)}
button{cursor:pointer;background:var(--surface);font-weight:500;transition:background .15s}
button:hover{background:var(--border)}
button:disabled{opacity:.5;cursor:wait}
button.selected{background:var(--green);color:#fff;border-color:var(--green);opacity:1;cursor:default}
button.primary{background:var(--blue);color:#fff;border-color:var(--blue)}
button.primary:hover{opacity:.9}
textarea{width:100%;min-height:4rem;resize:vertical}

/* Candidate cards */
.candidates{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem;margin:1rem 0}
.candidate{border:1px solid var(--border);border-radius:8px;padding:1rem;position:relative}
.candidate img{width:100%;background:white;border:1px solid var(--border);border-radius:4px;margin:.5rem 0;cursor:zoom-in}
.candidate h4{margin:0 0 .25rem}
.candidate p{margin:.25rem 0;color:var(--muted);font-size:.9rem}
.image-modal{display:none;position:fixed;inset:0;z-index:10;padding:2rem;background:rgba(0,0,0,.86);align-items:center;justify-content:center;cursor:zoom-out}
.image-modal.open{display:flex}
.image-modal img{max-width:96vw;max-height:92vh;background:white;box-shadow:0 4px 24px #000;cursor:zoom-out}

/* Feedback area */
#feedback{min-height:1.2em;color:var(--green);font-size:.9rem;margin:.5rem 0}
#feedback.error{color:var(--red)}

/* Aspect / comment */
.action-form{margin:1rem 0;display:flex;flex-direction:column;gap:.75rem}
.action-form label{font-weight:500;font-size:.9rem}

/* Gate badges */
.gate-badge{display:inline-block;padding:.15rem .5rem;border-radius:4px;font-size:.8rem;font-weight:600}
.gate-badge.pass{background:#dafbe1;color:var(--green)}
.gate-badge.fail{background:#ffebe9;color:var(--red)}
@media(prefers-color-scheme:dark){
  .gate-badge.pass{background:#0d2818}
  .gate-badge.fail{background:#2d1114}
}
</style></head>
<body>
<div class="agent-banner">
  <h1><span id="agent-title">BPMN layout iteration</span> · <span class="phase" id="phase">Connecting…</span></h1>
  <p class="message" id="agent-message"></p>
</div>
<main id="content">
  <p style="color:var(--muted)">Loading…</p>
</main>
<div id="image-modal" class="image-modal" role="dialog" aria-modal="true"
     aria-label="Full-size diagram" onclick="closeImage(event)">
  <img id="image-modal-content" alt="" onclick="closeImage(event)">
</div>

<script>
const $ = s => document.querySelector(s);
const content = $('#content'), phase = $('#phase'),
      agentMsg = $('#agent-message');

let socket, currentAspect = '';

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[c]));
}

function openImage(src, alt) {
  const modal = $('#image-modal');
  const image = $('#image-modal-content');
  image.src = src;
  image.alt = alt;
  modal.classList.add('open');
}

function closeImage(event) {
  if (event.target.id === 'image-modal' || event.target.id === 'image-modal-content') {
    $('#image-modal').classList.remove('open');
  }
}

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') $('#image-modal').classList.remove('open');
});

function render(s) {
  phase.textContent = s.phase || 'unknown';
  const aspect = s.aspect || (s.aspects && s.aspects[0]);
  $('#agent-title').textContent = aspect
    ? `BPMN layout iteration: ${aspect}` : 'BPMN layout iteration';
  const instruction = s.candidates && s.candidates.length
    ? ' Review the options, then reply to the agent with the best candidate and any comment.' : '';
  agentMsg.textContent = (s.message || '') + instruction;

  let h = '';

  // Candidates
  if (s.candidates && s.candidates.length) {
    currentAspect = aspect || 'layout';
    h += '<div class="candidates">';
    for (const c of s.candidates) {
      const label = c.label || '?';
      const desc = c.description || '';
      const qg = c.quality_gate_passed === true ? '<span class="gate-badge pass">✓ gate</span>'
                : c.quality_gate_passed === false ? '<span class="gate-badge fail">⚠ gate</span>' : '';
      const failures = Array.isArray(c.quality_gate_failures) && c.quality_gate_failures.length
        ? `<p class="gate-details">${escapeHtml(c.quality_gate_failures.join('; '))}</p>` : '';
      const images = Array.isArray(c.images) ? c.images
        : (c.image_url ? [c.image_url] : []);
      h += `<article class="candidate">
        <h4>${escapeHtml(label)} ${qg}</h4>
        ${images.map((src, index) => `<img src="${escapeHtml(src)}"
          alt="Candidate ${escapeHtml(label)}, graph ${index + 1}"
          onclick="openImage(this.src, this.alt)">`).join('')}
        <p>${escapeHtml(desc)}</p>${failures}
      </article>`;
    }
    h += '</div>';
  }

  // Accepted phase
  // Processing phase
  if (s.phase === 'processing') {
    h += '<p style="color:var(--muted)">⏳ The agent is working. This page updates automatically.</p>';
  }

  content.innerHTML = h;
}

// WebSocket connection
async function loadState() {
  try {
    const response = await fetch('/api/state', {cache: 'no-store'});
    if (!response.ok) throw new Error(`state request failed: ${response.status}`);
    render(await response.json());
  } catch (error) {
    phase.textContent = 'disconnected';
    phase.style.color = 'var(--red)';
    agentMsg.textContent = 'Unable to load the layout agent state.';
    console.error(error);
  }
}

function connect() {
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  socket.onmessage = e => {
    const msg = JSON.parse(e.data);
    render(msg);
  };
  socket.onopen = () => { loadState(); };
  socket.onclose = () => { loadState(); setTimeout(connect, 2000); };
  socket.onerror = () => { loadState(); };
}
loadState();
connect();
</script>
</body></html>"""


# -- Review page (per-report detail with images and metrics) ---------------

REVIEW_HTML = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Review: {{REPORT_ID}}</title>
<style>
:root {
  --bg: #ffffff; --fg: #1f2328; --border: #d0d7de; --muted: #656d76;
  --blue: #0969da; --green: #1a7f37; --red: #cf222e;
  --code-bg: #f6f8fa; --surface: #f6f8fa;
  color-scheme: light dark; font: 16px/1.5 system-ui, -apple-system, sans-serif;
}
@media(max-width:900px){.candidates{grid-template-columns:1fr}}
@media(prefers-color-scheme:dark){:root{
  --bg:#0d1117;--fg:#e6edf3;--border:#30363d;--muted:#8b949e;
  --blue:#58a6ff;--green:#3fb950;--red:#f85149;
  --code-bg:#161b22;--surface:#161b22;
}}
*,*::before,*::after{box-sizing:border-box}
body{max-width:1400px;margin:0 auto;padding:1.5rem;color:var(--fg);background:var(--bg)}
a{color:var(--blue)}

h1{font-size:1.3rem;margin:0 0 .25rem}
h2{font-size:1.15rem;margin:2rem 0 .5rem;padding-top:1.5rem;border-top:1px solid var(--border)}
h2:first-of-type{border-top:none;margin-top:1rem}

.breadcrumb{font-size:.85rem;color:var(--muted);margin-bottom:1rem}
.source-path{font-size:.85rem;color:var(--muted);margin:.25rem 0 .75rem}

/* Quality gate */
.gate{padding:.75rem 1rem;border-radius:8px;margin-bottom:1.5rem;font-size:.9rem}
.gate ul{margin:.4rem 0 0;padding-left:1.2rem}
.gate-pass{background:#dafbe1;color:var(--green);border:1px solid #afdcc8}
.gate-fail{background:#ffebe9;color:var(--red);border:1px solid #ffcecb}
@media(prefers-color-scheme:dark){
  .gate-pass{background:#0d2818;border-color:#1a4731}
  .gate-fail{background:#2d1114;border-color:#5c2d2f}
}

/* Side-by-side images */
.comparison{display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin:.75rem 0}
@media(max-width:900px){.comparison{grid-template-columns:1fr}}
figure{margin:0;border:1px solid var(--border);border-radius:6px;padding:.75rem;overflow:hidden}
figcaption{font-weight:600;font-size:.9rem;margin-bottom:.5rem}
.img-scroll{overflow:auto;max-height:500px}
.img-scroll img{max-width:100%;background:white;display:block}

/* Metrics table */
details{margin:.75rem 0}
summary{cursor:pointer;font-weight:600;font-size:.95rem;padding:.25rem 0}
table{border-collapse:collapse;width:100%;margin:.5rem 0;font-size:.9rem}
th,td{border:1px solid var(--border);padding:.3rem .5rem;text-align:right}
th:first-child{text-align:left;font-weight:500}
thead th{background:var(--surface);font-weight:600}
</style></head>
<body>
<div class="breadcrumb"><a href="/">← Dashboard</a> / {{REPORT_ID}}</div>
<h1>Report: {{REPORT_ID}}</h1>
{{GATE}}
{{SECTIONS}}
<p style="margin-top:2rem;font-size:.85rem;color:var(--muted)">
  Raw metrics: <a href="/reports/{{REPORT_ID}}/metrics.json" target="_blank">metrics.json</a>
  · <a href="/reports/{{REPORT_ID}}/index.html" target="_blank">Static report</a>
</p>
</body></html>"""


FIXTURES_HTML = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Updated BPMN fixtures</title>
<style>
:root{color-scheme:light dark;font:16px/1.5 system-ui,-apple-system,sans-serif;--border:#d0d7de;--muted:#656d76}
body{max-width:1200px;margin:0 auto;padding:1.5rem}
a{color:#0969da}
h1{font-size:1.5rem}
.source-path{color:var(--muted);font-size:.9rem}
.fixture{border-top:1px solid var(--border);padding:1.5rem 0}
.fixture img{display:block;max-width:100%;max-height:80vh;background:#fff;border:1px solid var(--border);overflow:auto}
</style></head><body>
<p><a href="/">← Dashboard</a></p>
<h1>Updated BPMN fixtures</h1>
<p>Each fixture was updated with the current <code>bpmn-auto-layout</code> command and is shown in fixture order.</p>
{{FIXTURES}}
</body></html>"""


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--host", default=os.environ.get("HOST", "127.0.0.1")
    )
    parser.add_argument(
        "--port", type=int, default=int(os.environ.get("PORT", "8000"))
    )
    args = parser.parse_args()
    import uvicorn

    print(f"\n  BPMN Layout Feedback UI: http://{args.host}:{args.port}/\n")
    uvicorn.run(app, host=args.host, port=args.port)

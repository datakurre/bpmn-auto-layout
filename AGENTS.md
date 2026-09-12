# Agent Guide: Using `bpmn-to-image`

This repository provides a Nix development shell containing Node.js, npm, and [`bpmn-to-image`](https://github.com/datakurre/bpmn-to-image) on `PATH`.

## Environment Setup

Always run commands non-interactively within the flake development shell:

```bash
nix develop --command <command>
```

Key executables available on `PATH` inside the shell:

- `bpmn-to-image`: CLI for rendering BPMN 2.0 XML to static images and animated executions.
- `node`: Node.js runtime.
- `npm`: Node package manager.

To verify the tools:

```bash
nix develop --command sh -c "bpmn-to-image --version && node --version && npm --version"
```

---

## What is `bpmn-to-image`?

`bpmn-to-image` renders BPMN 2.0 XML diagrams headlessly using `bpmn-js` in a JSDOM environment and rasterizes them with `@resvg/resvg-js`. It requires no browser or canvas build dependencies, and comes wrapped with `ffmpeg` for advanced animations.

It is particularly useful for:

- Rendering generated or layouted BPMN diagrams into SVG or PNG for visual inspection and artifacts.
- Verifying layout correctness after applying automated layout algorithms.
- Creating step-by-step animations (GIF, APNG, MP4, WebP) or frame sequences of token simulations.

---

## CLI Reference

### Basic Syntax

```bash
bpmn-to-image [options] [input] [output]
```

- `input`: Path to a `.bpmn` or `.xml` file. Omit or use `-` to read from `stdin`.
- `output`: Path for the rendered output. Omit or use `-` to write to `stdout`.

### Key Options

| Flag                       | Description                                                             | Default                                                       |
| -------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------- |
| `-f, --format <fmt>`       | Output format: `svg`, `png`, `gif`, `apng`, `mp4`, `webp`.              | Inferred from output extension (defaults to `svg` for stdout) |
| `-s, --scale <number>`     | Scale multiplier for raster formats (PNG or animations).                | `2`                                                           |
| `-b, --background <color>` | Background CSS color string (e.g., `white`, `#ffffff`).                 | Transparent for SVG/PNG/GIF/APNG/WebP; `white` for MP4        |
| `--scenario <file>`        | Path to a TOML scenario file steering token simulation paths.           | Diagram default path                                          |
| `--export-scenario`        | Generate a scenario TOML scaffold for the diagram.                      | Off                                                           |
| `--frames <dir>`           | Export individual frames into a directory (`frame-0000.svg` or `.png`). | None                                                          |
| `--fps <number>`           | Animation frame rate.                                                   | `12`                                                          |
| `--smooth`                 | Shortcut for smoother animation (30 fps).                               | Off                                                           |
| `--encoder <encoder>`      | GIF encoder: `auto`, `ffmpeg`, or `gifenc`.                             | `auto` (uses `ffmpeg` when present)                           |

---

## Common Workflows & Examples

### 1. Render BPMN to SVG

Vector output with transparent background:

```bash
nix develop --command bpmn-to-image diagram.bpmn diagram.svg
```

Using pipes (stdin/stdout):

```bash
cat diagram.bpmn | nix develop --command bpmn-to-image --format svg - > diagram.svg
```

### 2. Render BPMN to PNG

For visual review or artifacts, setting an explicit background like `white` is recommended so text and lines render cleanly against dark UI viewers:

```bash
nix develop --command bpmn-to-image --background white --scale 2 diagram.bpmn diagram.png
```

### 3. Generate Scenario Template & Animations

To animate process execution:

1. Export a runnable scenario scaffold based on the diagram's control flow:

   ```bash
   nix develop --command bpmn-to-image --export-scenario diagram.bpmn scenario.toml
   ```

2. Render the animation (GIF or MP4):

   ```bash
   nix develop --command bpmn-to-image --scenario scenario.toml diagram.bpmn diagram.gif
   ```

3. Export individual simulation frames (e.g. for step-by-step diffing or inspection):
   ```bash
   nix develop --command bpmn-to-image --scenario scenario.toml --frames ./frames --format png diagram.bpmn
   ```

---

## Best Practices for Agents

1. **Non-Interactive Execution**: Always invoke via `nix develop --command <command>`. Do not start a bare `nix develop` shell.
2. **Background Color**: Default background is transparent for SVG/PNG. When generating image artifacts for visual inspection, add `--background white` for readability.
3. **Piping & Automation**: When building layout scripts, you can pipe BPMN XML directly into `bpmn-to-image - diagram.svg` to check layout output without creating intermediate files.
4. **Git Tracking**: When adding new files to be seen by Nix (like new flake inputs, package derivations, or test fixtures), remember to run `git add <file>` first.

import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Baseline rules for all src files.
    // These enforce cohesion across the module graph.
    files: ["src/**/*.ts"],
    rules: {
      "max-lines": [
        "error",
        {
          // Hard cap: a module approaching 600 lines should be split.
          max: 600,
          skipBlankLines: true,
          skipComments: true,
        },
      ],
      "max-params": ["warn", 5],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "warn",
      "prefer-const": "warn",
    },
  },
  {
    // Orchestrator and pure-data modules: full structural guards.
    files: [
      "src/auto-layout.ts",
      "src/element-dimensions.ts",
      "src/graph-analysis.ts",
      "src/channel-planning.ts",
      "src/layout-types.ts",
      "src/layout-policy.ts",
    ],
    rules: {
      complexity: ["error", 10],
      "max-depth": ["warn", 3],
      "max-lines-per-function": ["warn", 50],
    },
  },
  {
    // Node placement: medium guard.  packIndependentComponents and
    // buildTrackColMaps are algorithmic but could be further split.
    files: ["src/node-placement.ts"],
    rules: {
      complexity: ["warn", 30],
      "max-depth": ["warn", 4],
      "max-lines-per-function": ["warn", 180],
    },
  },
  {
    // DI creation: orchestration is inherently multi-branch.
    // The createProcessDi function touches every routing and label path;
    // high complexity here is a signal that it needs further splitting later.
    files: ["src/di-creation.ts"],
    rules: {
      complexity: ["warn", 65],
      "max-depth": ["warn", 4],
      "max-lines-per-function": ["warn", 250],
    },
  },
  {
    // Geometric algorithms: orthogonal routing, visibility-graph Dijkstra,
    // and segment nudging are inherently complex.  Warn rather than error so
    // CI doesn't block on algorithm tuning; error only when the threshold is
    // exceeded far beyond the current baseline, signaling out-of-control growth.
    files: ["src/collision-repair.ts", "src/edge-routing.ts"],
    rules: {
      complexity: ["warn", 50],
      "max-depth": ["warn", 5],
      "max-lines-per-function": ["warn", 280],
    },
  },
  {
    // Label placement: candidate enumeration is wide but bounded.
    files: ["src/label-placement.ts"],
    rules: {
      complexity: ["warn", 70],
      "max-depth": ["warn", 4],
      "max-lines-per-function": ["warn", 200],
    },
  },
  {
    // label-layout.ts: existing bpmnlint rule; relax depth and complexity
    // to avoid blocking bpmnlint logic additions.
    files: ["src/label-layout.ts"],
    rules: {
      complexity: ["warn", 55],
      "max-depth": ["warn", 5],
    },
  },
);

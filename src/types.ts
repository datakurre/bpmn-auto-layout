export interface Point {
  x: number;
  y: number;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ElementDimension {
  width: number;
  height: number;
}

export interface AutoLayoutOptions {
  /**
   * Grid channel spacing between nodes. Defaults to 60.
   */
  gridSpacing?: number;

  /**
   * Whether to allow invalid sequence flows (e.g. cross-container or unresolvable endpoints)
   * without throwing an error. Defaults to false.
   */
  lenientFlowValidation?: boolean;

  /**
   * Additional Moddle extensions to register.
   */
  moddleExtensions?: Record<string, any>;

  /**
   * Maximum width budget before wrapping flow nodes onto multiple rows.
   */
  widthBudget?: number;

  /**
   * Whether to align all terminal end events to the maximum rank in their scope.
   * Defaults to false.
   */
  alignEndEvents?: boolean;
}

export interface HardViolations {
  shapeOverlaps: number;
  edgeShapeCrossings: number;
  nonOrthogonalSegments: number;
}

export interface QualityMetrics {
  totalBends: number;
  totalEdgeLength: number;
  edgeCrossings: number;
}

export interface ContainerCompactness {
  id: string;
  elementId: string;
  width: number;
  height: number;
  area: number;
  aspectRatio: number;
  densityRatio: number;
}

export interface CompactnessMetrics {
  width: number;
  height: number;
  area: number;
  aspectRatio: number;
  densityRatio: number;
  containers: ContainerCompactness[];
}

export interface DiagramQualityScore {
  hardViolations: HardViolations;
  metrics: QualityMetrics;
  compactness: CompactnessMetrics;
  isValid: boolean;
}

export type { LayoutWarning, LayoutWarningCode } from './layout-warnings';

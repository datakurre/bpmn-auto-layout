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
   * Primary flow direction. Defaults to 'horizontal' (left-to-right).
   */
  direction?: 'horizontal' | 'vertical';

  /**
   * Grid channel spacing between nodes. Defaults to 60.
   */
  gridSpacing?: number;

  /**
   * Additional Moddle extensions to register.
   */
  moddleExtensions?: Record<string, any>;
}

export interface HardViolations {
  shapeOverlaps: number;
  edgeShapeCrossings: number;
  nonOrthogonalSegments: number;
  collinearDeviations: number;
}

export interface QualityMetrics {
  totalBends: number;
  totalEdgeLength: number;
  edgeCrossings: number;
  symmetryError: number;
}

export interface DiagramQualityScore {
  hardViolations: HardViolations;
  metrics: QualityMetrics;
  isValid: boolean;
}

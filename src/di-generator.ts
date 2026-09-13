import type { BPMNModdle } from 'bpmn-moddle';
import type { Bounds, Point } from './types';

export interface ShapeConfig extends Bounds {
  isExpanded?: boolean;
  labelBounds?: Bounds;
}

export interface EdgeConfig {
  bpmnElement: any;
  waypoints: Point[];
  labelBounds?: Bounds;
}

export class DiGenerator {
  private moddle: BPMNModdle;

  constructor(moddle: BPMNModdle) {
    this.moddle = moddle;
  }

  public ensureDiagram(definitions: any, targetElement: any): any {
    if (!definitions.diagrams) {
      definitions.diagrams = [];
    }

    let diagram = definitions.diagrams[0];
    if (!diagram) {
      const plane = this.moddle.create('bpmndi:BPMNPlane', {
        id: `BPMNPlane_1`,
        bpmnElement: targetElement,
        planeElement: [],
      });
      diagram = this.moddle.create('bpmndi:BPMNDiagram', {
        id: `BPMNDiagram_1`,
        plane,
      });
      definitions.diagrams.push(diagram);
    }

    if (!diagram.plane) {
      diagram.plane = this.moddle.create('bpmndi:BPMNPlane', {
        id: `BPMNPlane_1`,
        bpmnElement: targetElement,
        planeElement: [],
      });
    }

    if (!diagram.plane.planeElement) {
      diagram.plane.planeElement = [];
    }

    diagram.plane.bpmnElement = targetElement;
    return diagram;
  }

  public addShape(plane: any, bpmnElement: any, config: ShapeConfig): any {
    const dcBounds = this.moddle.create('dc:Bounds', {
      x: config.x,
      y: config.y,
      width: config.width,
      height: config.height,
    });

    const shapeProps: Record<string, any> = {
      id: `${bpmnElement.id}_di`,
      bpmnElement,
      bounds: dcBounds,
    };

    if (typeof config.isExpanded === 'boolean') {
      shapeProps.isExpanded = config.isExpanded;
    }

    if (config.labelBounds) {
      const dcLabelBounds = this.moddle.create('dc:Bounds', {
        x: config.labelBounds.x,
        y: config.labelBounds.y,
        width: config.labelBounds.width,
        height: config.labelBounds.height,
      });
      shapeProps.label = this.moddle.create('bpmndi:BPMNLabel', {
        bounds: dcLabelBounds,
      });
    }

    const shape = this.moddle.create('bpmndi:BPMNShape', shapeProps);
    plane.planeElement.push(shape);
    return shape;
  }

  public addEdge(plane: any, config: EdgeConfig): any {
    const { bpmnElement, waypoints, labelBounds } = config;
    const diWaypoints = waypoints.map((pt) =>
      this.moddle.create('dc:Point', {
        x: pt.x,
        y: pt.y,
      })
    );

    const edgeProps: Record<string, any> = {
      id: `${bpmnElement.id}_di`,
      bpmnElement,
      waypoint: diWaypoints,
    };

    if (labelBounds) {
      const dcLabelBounds = this.moddle.create('dc:Bounds', {
        x: labelBounds.x,
        y: labelBounds.y,
        width: labelBounds.width,
        height: labelBounds.height,
      });
      edgeProps.label = this.moddle.create('bpmndi:BPMNLabel', {
        bounds: dcLabelBounds,
      });
    }

    const edge = this.moddle.create('bpmndi:BPMNEdge', edgeProps);
    plane.planeElement.push(edge);
    return edge;
  }
}

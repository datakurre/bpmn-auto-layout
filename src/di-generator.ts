import type { BPMNModdle } from 'bpmn-moddle';
import type { Bounds, Point } from './types';

export interface ShapeConfig extends Bounds {
  isExpanded?: boolean;
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

    const shape = this.moddle.create('bpmndi:BPMNShape', shapeProps);
    plane.planeElement.push(shape);
    return shape;
  }

  public addEdge(plane: any, bpmnElement: any, waypoints: Point[]): any {
    const diWaypoints = waypoints.map((pt) =>
      this.moddle.create('dc:Point', {
        x: pt.x,
        y: pt.y,
      })
    );

    const edge = this.moddle.create('bpmndi:BPMNEdge', {
      id: `${bpmnElement.id}_di`,
      bpmnElement,
      waypoint: diWaypoints,
    });
    plane.planeElement.push(edge);
    return edge;
  }
}

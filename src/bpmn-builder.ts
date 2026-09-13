import { BpmnModdle, type BPMNModdle } from 'bpmn-moddle';

export interface FlowConfig {
  id: string;
  sourceRef: string;
  targetRef: string;
  name?: string;
}

export interface BoundaryEventConfig {
  id: string;
  attachedToRef: string;
  name?: string;
  eventDefinitionType?: string;
  cancelActivity?: boolean;
}

export class BpmnBuilder {
  private moddle: BPMNModdle;
  private definitions: any;
  private process: any;
  private collaboration: any | null = null;
  private elementMap: Map<string, any> = new Map();

  constructor(processId = 'Process_1', definitionsId = 'Definitions_1') {
    this.moddle = new BpmnModdle();
    this.definitions = this.moddle.create('bpmn:Definitions', {
      id: definitionsId,
      targetNamespace: 'http://bpmn.io/schema/bpmn',
    });
    this.process = this.moddle.create('bpmn:Process', {
      id: processId,
      isExecutable: false,
    });
    this.process.flowElements = [];
    this.definitions.rootElements = [this.process];
    this.elementMap.set(processId, this.process);
  }

  public getModdle(): BPMNModdle {
    return this.moddle;
  }

  public getDefinitions(): any {
    return this.definitions;
  }

  public getProcess(): any {
    return this.process;
  }

  public addProcess(id: string, name?: string): this {
    const proc = this.moddle.create('bpmn:Process', {
      id,
      name,
      isExecutable: false,
    });
    proc.flowElements = [];
    this.definitions.rootElements.push(proc);
    this.elementMap.set(id, proc);
    this.process = proc;
    return this;
  }

  public addStartEvent(id: string, name?: string, eventDefinitionType?: string): this {
    if (!eventDefinitionType) {
      return this.addFlowNode('bpmn:StartEvent', id, name);
    }
    const def = this.moddle.create(eventDefinitionType);
    const element = this.moddle.create('bpmn:StartEvent', {
      id,
      name,
      eventDefinitions: [def],
    });
    this.process.flowElements.push(element);
    this.elementMap.set(id, element);
    return this;
  }

  public addEndEvent(id: string, name?: string, eventDefinitionType?: string): this {
    if (!eventDefinitionType) {
      return this.addFlowNode('bpmn:EndEvent', id, name);
    }
    const def = this.moddle.create(eventDefinitionType);
    const element = this.moddle.create('bpmn:EndEvent', {
      id,
      name,
      eventDefinitions: [def],
    });
    this.process.flowElements.push(element);
    this.elementMap.set(id, element);
    return this;
  }

  public addDataObject(id: string, name?: string): this {
    const element = this.moddle.create('bpmn:DataObject', { id, name });
    this.process.flowElements.push(element);
    this.elementMap.set(id, element);
    return this;
  }

  public addTask(id: string, name?: string, type = 'bpmn:Task'): this {
    return this.addFlowNode(type, id, name);
  }

  public addExclusiveGateway(id: string, name?: string): this {
    return this.addFlowNode('bpmn:ExclusiveGateway', id, name);
  }

  public addParallelGateway(id: string, name?: string): this {
    return this.addFlowNode('bpmn:ParallelGateway', id, name);
  }

  public addInclusiveGateway(id: string, name?: string): this {
    return this.addFlowNode('bpmn:InclusiveGateway', id, name);
  }

  public addIntermediateCatchEvent(id: string, name?: string): this {
    return this.addFlowNode('bpmn:IntermediateCatchEvent', id, name);
  }

  public addBoundaryEvent(
    idOrConfig: string | BoundaryEventConfig,
    attachedToRef?: string,
    name?: string
  ): this {
    const isObj = typeof idOrConfig === 'object';
    const id = isObj ? idOrConfig.id : idOrConfig;
    const hostId = isObj ? idOrConfig.attachedToRef : attachedToRef!;
    const eventName = isObj ? idOrConfig.name : name;
    const eventDefinitionType = isObj ? idOrConfig.eventDefinitionType : undefined;
    const cancelActivity = isObj ? idOrConfig.cancelActivity : undefined;

    const host = this.elementMap.get(hostId);
    const props: Record<string, any> = {
      id,
      name: eventName,
      attachedToRef: host || hostId,
    };
    if (eventDefinitionType) {
      props.eventDefinitions = [this.moddle.create(eventDefinitionType)];
    }
    if (typeof cancelActivity === 'boolean') {
      props.cancelActivity = cancelActivity;
    }

    const event = this.moddle.create('bpmn:BoundaryEvent', props);
    this.process.flowElements.push(event);
    this.elementMap.set(id, event);
    return this;
  }

  public addSubProcess(
    id: string,
    name?: string,
    configure?: (builder: BpmnBuilder) => void
  ): this {
    const subProcess = this.moddle.create('bpmn:SubProcess', {
      id,
      name,
    });
    subProcess.flowElements = [];
    this.process.flowElements.push(subProcess);
    this.elementMap.set(id, subProcess);

    if (configure) {
      const originalProcess = this.process;
      this.process = subProcess;
      configure(this);
      this.process = originalProcess;
    }

    return this;
  }

  public addEventSubProcess(
    id: string,
    name?: string,
    configure?: (builder: BpmnBuilder) => void
  ): this {
    const subProcess = this.moddle.create('bpmn:SubProcess', {
      id,
      name,
      triggeredByEvent: true,
    });
    subProcess.flowElements = [];
    this.process.flowElements.push(subProcess);
    this.elementMap.set(id, subProcess);

    if (configure) {
      const originalProcess = this.process;
      this.process = subProcess;
      configure(this);
      this.process = originalProcess;
    }

    return this;
  }

  public addAdHocSubProcess(
    id: string,
    name?: string,
    configure?: (builder: BpmnBuilder) => void
  ): this {
    const subProcess = this.moddle.create('bpmn:AdHocSubProcess', {
      id,
      name,
    });
    subProcess.flowElements = [];
    this.process.flowElements.push(subProcess);
    this.elementMap.set(id, subProcess);

    if (configure) {
      const originalProcess = this.process;
      this.process = subProcess;
      configure(this);
      this.process = originalProcess;
    }

    return this;
  }

  public addDataObjectReference(id: string, name?: string, dataObjectRef?: string): this {
    const props: Record<string, any> = { id, name };
    if (dataObjectRef) {
      props.dataObjectRef = this.elementMap.get(dataObjectRef) || dataObjectRef;
    }
    const element = this.moddle.create('bpmn:DataObjectReference', props);
    this.process.flowElements.push(element);
    this.elementMap.set(id, element);
    return this;
  }

  public addDataStoreReference(id: string, name?: string): this {
    const element = this.moddle.create('bpmn:DataStoreReference', { id, name });
    this.process.flowElements.push(element);
    this.elementMap.set(id, element);
    return this;
  }

  public addTextAnnotation(id: string, text: string): this {
    if (!this.process.artifacts) {
      this.process.artifacts = [];
    }
    const element = this.moddle.create('bpmn:TextAnnotation', { id, text });
    this.process.artifacts.push(element);
    this.elementMap.set(id, element);
    return this;
  }

  public addAssociation(id: string, sourceRef: string, targetRef: string): this {
    if (!this.process.artifacts) {
      this.process.artifacts = [];
    }
    const source = this.elementMap.get(sourceRef) || sourceRef;
    const target = this.elementMap.get(targetRef) || targetRef;
    const element = this.moddle.create('bpmn:Association', {
      id,
      sourceRef: source,
      targetRef: target,
    });
    this.process.artifacts.push(element);
    this.elementMap.set(id, element);
    return this;
  }

  public addSequenceFlow(
    idOrConfig: string | FlowConfig,
    sourceRef?: string,
    targetRef?: string
  ): this {
    const isObj = typeof idOrConfig === 'object';
    const id = isObj ? idOrConfig.id : idOrConfig;
    const srcId = isObj ? idOrConfig.sourceRef : sourceRef!;
    const tgtId = isObj ? idOrConfig.targetRef : targetRef!;
    const name = isObj ? idOrConfig.name : undefined;

    const source = this.elementMap.get(srcId);
    const target = this.elementMap.get(tgtId);
    const props: Record<string, any> = {
      id,
      sourceRef: source,
      targetRef: target,
    };
    if (name) {
      props.name = name;
    }
    const flow = this.moddle.create('bpmn:SequenceFlow', props);
    this.process.flowElements.push(flow);
    this.elementMap.set(id, flow);
    return this;
  }

  public addLane(id: string, elementIds: string[], name?: string): this {
    if (!this.process.laneSets) {
      const laneSet = this.moddle.create('bpmn:LaneSet', {
        id: `${this.process.id}_LaneSet`,
        lanes: [],
      });
      this.process.laneSets = [laneSet];
    }
    const flowNodes = elementIds.map((elementId) => this.elementMap.get(elementId) || elementId);
    const lane = this.moddle.create('bpmn:Lane', {
      id,
      name,
      flowNodeRef: flowNodes,
    });
    this.process.laneSets[0].lanes.push(lane);
    return this;
  }

  public addCollaboration(id = 'Collaboration_1'): this {
    if (!this.collaboration) {
      this.collaboration = this.moddle.create('bpmn:Collaboration', {
        id,
        participants: [],
        messageFlows: [],
      });
      this.definitions.rootElements.unshift(this.collaboration);
    }
    return this;
  }

  public addParticipant(id: string, processRef: string, name?: string): this {
    this.addCollaboration();
    const targetProcess = this.elementMap.get(processRef) || processRef;
    const participant = this.moddle.create('bpmn:Participant', {
      id,
      name,
      processRef: targetProcess,
    });
    this.collaboration.participants.push(participant);
    this.elementMap.set(id, participant);
    return this;
  }

  public addMessageFlow(
    idOrConfig: string | FlowConfig,
    sourceRef?: string,
    targetRef?: string
  ): this {
    this.addCollaboration();
    const isObj = typeof idOrConfig === 'object';
    const id = isObj ? idOrConfig.id : idOrConfig;
    const srcId = isObj ? idOrConfig.sourceRef : sourceRef!;
    const tgtId = isObj ? idOrConfig.targetRef : targetRef!;
    const name = isObj ? idOrConfig.name : undefined;

    const source = this.elementMap.get(srcId);
    const target = this.elementMap.get(tgtId);
    const props: Record<string, any> = {
      id,
      sourceRef: source || srcId,
      targetRef: target || tgtId,
    };
    if (name) {
      props.name = name;
    }
    const messageFlow = this.moddle.create('bpmn:MessageFlow', props);
    this.collaboration.messageFlows.push(messageFlow);
    this.elementMap.set(id, messageFlow);
    return this;
  }

  public async toXml(): Promise<string> {
    const { xml } = await this.moddle.toXML(this.definitions, { format: true });
    return xml;
  }

  private addFlowNode(type: string, id: string, name?: string): this {
    const element = this.moddle.create(type, { id, name });
    this.process.flowElements.push(element);
    this.elementMap.set(id, element);
    return this;
  }
}

interface ElementLike {
    id: string;
    $type: string;
    name?: string;
    flowElements?: ElementLike[];
    laneSets?: Array<{
        lanes?: ElementLike[];
    }>;
    childLaneSet?: {
        lanes?: ElementLike[];
    };
    $parent?: ElementLike;
}
interface ReporterLike {
    report(id: string, message: string): void;
}
/** Materialize the same default label rectangles bpmn-js uses before linting or saving. */
export declare function ensureLabelDi(xml: string): Promise<string>;
/** Validate serialized bpmn-js label placement without reproducing its adaptive positioning. */
export declare function labelLayout(): {
    check(node: ElementLike, reporter: ReporterLike): void;
};
export {};

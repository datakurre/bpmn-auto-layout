export interface AutoLayoutOptions {
    colWidth?: number;
    spineY?: number;
    track1Y?: number;
    track2Y?: number;
    trackGap?: number;
    channel1Y?: number;
    channel2Y?: number;
    channel3Y?: number;
}
export declare function layoutProcess(xml: string, options?: AutoLayoutOptions): Promise<string>;

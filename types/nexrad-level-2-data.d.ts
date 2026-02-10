declare module 'nexrad-level-2-data' {
  export interface Level2HighResData {
    gate_count: number;
    first_gate: number;
    gate_size: number;
    moment_data: Array<number | null>;
  }

  export interface Level2MessageHeader {
    elevation_angle: number;
  }

  export interface Level2ParserOptions {
    logger?: false | { log: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
  }

  export class Level2Radar {
    constructor(file: Buffer, options?: Level2ParserOptions);
    setElevation(elevation: number): void;
    listElevations(): number[];
    getScans(): number;
    getAzimuth(scan: number): number;
    getHeader(scan: number): Level2MessageHeader;
    getHighresReflectivity(scan: number): Level2HighResData;
  }
}

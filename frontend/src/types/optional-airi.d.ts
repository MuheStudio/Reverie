declare module '*stage-ui-live2d/src' {
  export const Live2DModel: {
    load(modelPath: string): Promise<unknown>;
  };
}

declare module '*stage-ui-three/src' {
  export const VRMModel: {
    load(modelPath: string): Promise<unknown>;
  };
}

declare module 'pixi-live2d-display/cubism4' {
  export class Live2DModel {
    static registerTicker(ticker: unknown): void;
    static from(
      source: string,
      options?: {
        autoInteract?: boolean;
      },
    ): Promise<any>;
  }
}

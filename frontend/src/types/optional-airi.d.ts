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

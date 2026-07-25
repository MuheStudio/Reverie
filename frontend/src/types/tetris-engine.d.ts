declare module 'tetris-engine' {
  export interface TetrisCell {
    val: 0 | 1 | 2;
    cssClasses: Array<string | null>;
  }

  export interface TetrisState {
    gameStatus: 0 | 1 | 2 | 3;
    body: TetrisCell[][];
    shapeName: string | null;
    nextShape: { name: string | null; body: number[][] | null };
    statistic: {
      countShapesFalled: number;
      countLinesReduced: number;
      countDoubleLinesReduced: number;
      countTrippleLinesReduced: number;
      countQuadrupleLinesReduced: number;
    };
  }

  export class Engine {
    constructor(width: number, height: number, render: (state: TetrisState) => void);
    readonly state: TetrisState;
    start(): boolean | void;
    pause(): boolean | void;
    moveLeft(): void;
    moveRight(): void;
    moveDown(): void;
    rotate(): void;
    rotateBack(): void;
  }
}

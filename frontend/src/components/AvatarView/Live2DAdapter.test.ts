import { describe, expect, it } from 'vitest';
import { calculateHeadCentredGaze } from './Live2DAdapter';

describe('Live2D head-centred gaze', () => {
  it('is neutral at the face anchor and preserves the Cubism up-positive axis', () => {
    expect(calculateHeadCentredGaze({
      pointerX: 320,
      pointerY: 180,
      headX: 320,
      headY: 180,
      modelWidth: 400,
      modelHeight: 700,
    })).toEqual({ x: 0, y: 0 });
    const upRight = calculateHeadCentredGaze({
      pointerX: 390,
      pointerY: 110,
      headX: 320,
      headY: 180,
      modelWidth: 400,
      modelHeight: 700,
    });
    expect(upRight.x).toBeGreaterThan(0);
    expect(upRight.y).toBeGreaterThan(0);
  });

  it('clamps hostile and zero-sized geometry to finite focus values', () => {
    expect(calculateHeadCentredGaze({
      pointerX: Number.MAX_SAFE_INTEGER,
      pointerY: Number.MIN_SAFE_INTEGER,
      headX: 0,
      headY: 0,
      modelWidth: 0,
      modelHeight: 0,
    })).toEqual({ x: 1, y: 1 });
  });
});

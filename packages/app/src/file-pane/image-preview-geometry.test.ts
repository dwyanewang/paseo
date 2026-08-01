import { describe, expect, it } from "vitest";
import {
  clampImageScale,
  clampImageTranslation,
  containImageSize,
  getDoubleTapImageScale,
  resetImageTransform,
  zoomImageAroundPoint,
} from "./image-preview-geometry";

describe("image preview geometry", () => {
  it("fits images inside the viewport", () => {
    expect(containImageSize({ width: 1200, height: 600 }, { width: 300, height: 500 })).toEqual({
      width: 300,
      height: 150,
    });
  });

  it("limits scale and translation", () => {
    expect(clampImageScale(0.5)).toBe(1);
    expect(clampImageScale(5)).toBe(4);
    expect(
      clampImageTranslation({
        translation: { x: 500, y: -500 },
        scale: 2,
        content: { width: 300, height: 200 },
        viewport: { width: 300, height: 500 },
      }),
    ).toEqual({ x: 150, y: 0 });
  });

  it("reclamps translation when the viewport rotates", () => {
    const image = { width: 1200, height: 600 };
    const landscapeViewport = { width: 600, height: 300 };
    const portraitViewport = { width: 300, height: 600 };
    const translation = clampImageTranslation({
      translation: { x: 400, y: -400 },
      scale: 2,
      content: containImageSize(image, landscapeViewport),
      viewport: landscapeViewport,
    });

    expect(
      clampImageTranslation({
        translation,
        scale: 2,
        content: containImageSize(image, portraitViewport),
        viewport: portraitViewport,
      }),
    ).toEqual({ x: 150, y: 0 });
  });

  it("keeps the pinch focal point stationary while zooming", () => {
    expect(
      zoomImageAroundPoint({
        scale: 1,
        translation: { x: 0, y: 0 },
        targetScale: 2,
        focal: { x: 225, y: 250 },
        content: { width: 300, height: 500 },
        viewport: { width: 300, height: 500 },
      }),
    ).toEqual({ scale: 2, translation: { x: -75, y: 0 } });
  });

  it("toggles double tap zoom and resets when the image changes", () => {
    expect(getDoubleTapImageScale(1)).toBe(2);
    expect(getDoubleTapImageScale(2)).toBe(1);
    expect(resetImageTransform()).toEqual({ scale: 1, translation: { x: 0, y: 0 } });
  });
});

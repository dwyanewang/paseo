export const MIN_IMAGE_SCALE = 1;
export const MAX_IMAGE_SCALE = 4;

export interface ImagePreviewPoint {
  x: number;
  y: number;
}

export interface ImagePreviewSize {
  width: number;
  height: number;
}

export interface ImagePreviewTransform {
  scale: number;
  translation: ImagePreviewPoint;
}

export function clampImageScale(scale: number): number {
  "worklet";
  return Math.min(MAX_IMAGE_SCALE, Math.max(MIN_IMAGE_SCALE, scale));
}

export function containImageSize(
  image: ImagePreviewSize,
  viewport: ImagePreviewSize,
): ImagePreviewSize {
  if (image.width <= 0 || image.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    return { width: 0, height: 0 };
  }
  const ratio = Math.min(viewport.width / image.width, viewport.height / image.height);
  return { width: image.width * ratio, height: image.height * ratio };
}

export function clampImageTranslation(input: {
  translation: ImagePreviewPoint;
  scale: number;
  content: ImagePreviewSize;
  viewport: ImagePreviewSize;
}): ImagePreviewPoint {
  "worklet";
  const maxX = Math.max(0, (input.content.width * input.scale - input.viewport.width) / 2);
  const maxY = Math.max(0, (input.content.height * input.scale - input.viewport.height) / 2);
  return {
    x: maxX === 0 ? 0 : Math.min(maxX, Math.max(-maxX, input.translation.x)),
    y: maxY === 0 ? 0 : Math.min(maxY, Math.max(-maxY, input.translation.y)),
  };
}

export function zoomImageAroundPoint(input: {
  scale: number;
  translation: ImagePreviewPoint;
  targetScale: number;
  focal: ImagePreviewPoint;
  content: ImagePreviewSize;
  viewport: ImagePreviewSize;
}): ImagePreviewTransform {
  "worklet";
  const targetScale = clampImageScale(input.targetScale);
  const scaleRatio = targetScale / input.scale;
  const viewportCenter = {
    x: input.viewport.width / 2,
    y: input.viewport.height / 2,
  };
  const translation = clampImageTranslation({
    translation: {
      x:
        input.translation.x +
        (input.focal.x - viewportCenter.x - input.translation.x) * (1 - scaleRatio),
      y:
        input.translation.y +
        (input.focal.y - viewportCenter.y - input.translation.y) * (1 - scaleRatio),
    },
    scale: targetScale,
    content: input.content,
    viewport: input.viewport,
  });
  return { scale: targetScale, translation };
}

export function getDoubleTapImageScale(scale: number): number {
  "worklet";
  return scale > MIN_IMAGE_SCALE ? MIN_IMAGE_SCALE : 2;
}

export function resetImageTransform(): ImagePreviewTransform {
  return {
    scale: MIN_IMAGE_SCALE,
    translation: { x: 0, y: 0 },
  };
}

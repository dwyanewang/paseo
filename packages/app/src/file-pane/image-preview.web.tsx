import type { AttachmentMetadata } from "@/attachments/types";
import { Button } from "@/components/ui/button";
import { Minus, Plus } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Image, PanResponder, View, type LayoutChangeEvent, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  MAX_IMAGE_SCALE,
  MIN_IMAGE_SCALE,
  clampImageTranslation,
  containImageSize,
  getDoubleTapImageScale,
  resetImageTransform,
  zoomImageAroundPoint,
  type ImagePreviewSize,
  type ImagePreviewTransform,
} from "./image-preview-geometry";

export interface FileImagePreviewProps {
  uri: string;
  fileName: string;
  attachment: AttachmentMetadata | null;
}

const EMPTY_SIZE: ImagePreviewSize = { width: 0, height: 0 };
const SCALE_STEP = 0.5;
const WHEEL_ZOOM_SENSITIVITY = 0.002;

export function FileImagePreview({ uri, fileName }: FileImagePreviewProps) {
  const { t } = useTranslation();
  const viewportRef = useRef<View>(null);
  const transformRef = useRef<ImagePreviewTransform>(resetImageTransform());
  const dragStartRef = useRef({ x: 0, y: 0 });
  const [viewport, setViewport] = useState<ImagePreviewSize>(EMPTY_SIZE);
  const [image, setImage] = useState<ImagePreviewSize>(EMPTY_SIZE);
  const [transform, setTransform] = useState<ImagePreviewTransform>(transformRef.current);
  const [dragging, setDragging] = useState(false);
  const content = useMemo(() => containImageSize(image, viewport), [image, viewport]);
  const source = useMemo(() => ({ uri }), [uri]);

  const updateTransform = useCallback(
    (update: (current: ImagePreviewTransform) => ImagePreviewTransform) => {
      setTransform((current) => {
        const next = update(current);
        transformRef.current = next;
        return next;
      });
    },
    [],
  );

  const resetZoom = useCallback(() => {
    const reset = resetImageTransform();
    transformRef.current = reset;
    setTransform(reset);
  }, []);

  useEffect(() => {
    let active = true;
    setImage(EMPTY_SIZE);
    resetZoom();
    Image.getSize(
      uri,
      (width, height) => {
        if (active) setImage({ width, height });
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [resetZoom, uri]);

  useEffect(() => {
    updateTransform((current) => ({
      ...current,
      translation: clampImageTranslation({
        translation: current.translation,
        scale: current.scale,
        content,
        viewport,
      }),
    }));
  }, [content, updateTransform, viewport]);

  const zoomAt = useCallback(
    (targetScale: number, focal = { x: viewport.width / 2, y: viewport.height / 2 }) => {
      updateTransform((current) =>
        zoomImageAroundPoint({
          scale: current.scale,
          translation: current.translation,
          targetScale,
          focal,
          content,
          viewport,
        }),
      );
    },
    [content, updateTransform, viewport],
  );

  useEffect(() => {
    const node = viewportRef.current as unknown as HTMLElement | null;
    if (!node) return;

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      zoomAt(transformRef.current.scale * Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY), {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    };
    const handleDoubleClick = (event: MouseEvent) => {
      const rect = node.getBoundingClientRect();
      zoomAt(getDoubleTapImageScale(transformRef.current.scale), {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    };

    node.addEventListener("wheel", handleWheel, { passive: false });
    node.addEventListener("dblclick", handleDoubleClick);
    return () => {
      node.removeEventListener("wheel", handleWheel);
      node.removeEventListener("dblclick", handleDoubleClick);
    };
  }, [zoomAt]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) =>
          transformRef.current.scale > MIN_IMAGE_SCALE &&
          (Math.abs(gesture.dx) >= 3 || Math.abs(gesture.dy) >= 3),
        onPanResponderGrant: () => {
          dragStartRef.current = transformRef.current.translation;
          setDragging(true);
        },
        onPanResponderMove: (_event, gesture) => {
          updateTransform((current) => ({
            scale: current.scale,
            translation: clampImageTranslation({
              translation: {
                x: dragStartRef.current.x + gesture.dx,
                y: dragStartRef.current.y + gesture.dy,
              },
              scale: current.scale,
              content,
              viewport,
            }),
          }));
        },
        onPanResponderRelease: () => setDragging(false),
        onPanResponderTerminate: () => setDragging(false),
      }),
    [content, updateTransform, viewport],
  );

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setViewport({ width, height });
  }, []);
  const handleZoomOut = useCallback(
    () => zoomAt(transformRef.current.scale - SCALE_STEP),
    [zoomAt],
  );
  const handleZoomIn = useCallback(() => zoomAt(transformRef.current.scale + SCALE_STEP), [zoomAt]);

  const imageFrameStyle = useMemo<ViewStyle>(
    () => ({
      width: content.width,
      height: content.height,
      transform: [
        { translateX: transform.translation.x },
        { translateY: transform.translation.y },
        { scale: transform.scale },
      ],
    }),
    [content.height, content.width, transform],
  );
  const viewportStyle = useMemo(
    () => [
      styles.viewport,
      transform.scale > MIN_IMAGE_SCALE
        ? ({ cursor: dragging ? "grabbing" : "grab" } as unknown as ViewStyle)
        : null,
    ],
    [dragging, transform.scale],
  );
  const percent = Math.round(transform.scale * 100);

  return (
    <View style={styles.container}>
      <View
        ref={viewportRef}
        {...panResponder.panHandlers}
        accessible
        focusable
        accessibilityRole="image"
        accessibilityLabel={t("panels.file.image.accessibilityLabel", { fileName })}
        accessibilityHint={t("panels.file.image.desktopAccessibilityHint")}
        style={viewportStyle}
        onLayout={handleLayout}
        testID="workspace-file-image"
      >
        {content.width > 0 && content.height > 0 ? (
          <View style={[styles.imageFrame, imageFrameStyle]} testID="workspace-file-image-frame">
            <Image
              source={source}
              resizeMode="contain"
              style={styles.image}
              testID="workspace-file-image-content"
            />
          </View>
        ) : (
          <Image source={source} resizeMode="contain" style={styles.image} />
        )}
      </View>
      <View pointerEvents="box-none" style={styles.toolbarPosition}>
        <View style={styles.toolbar}>
          <Button
            variant="ghost"
            size="xs"
            leftIcon={Minus}
            disabled={transform.scale <= MIN_IMAGE_SCALE}
            accessibilityLabel={t("panels.file.image.zoomOut")}
            onPress={handleZoomOut}
            testID="workspace-file-image-zoom-out"
          />
          <Button
            variant="ghost"
            size="xs"
            accessibilityLabel={t("panels.file.image.zoomLevel", { percent })}
            accessibilityHint={t("panels.file.image.resetZoom")}
            onPress={resetZoom}
            style={styles.zoomLevelButton}
            testID="workspace-file-image-zoom-level"
          >
            {percent}%
          </Button>
          <Button
            variant="ghost"
            size="xs"
            leftIcon={Plus}
            disabled={transform.scale >= MAX_IMAGE_SCALE}
            accessibilityLabel={t("panels.file.image.zoomIn")}
            onPress={handleZoomIn}
            testID="workspace-file-image-zoom-in"
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    position: "relative",
    padding: theme.spacing[4],
  },
  viewport: {
    flex: 1,
    minHeight: 0,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  imageFrame: {
    alignItems: "center",
    justifyContent: "center",
  },
  image: {
    width: "100%",
    height: "100%",
  },
  toolbarPosition: {
    position: "absolute",
    left: theme.spacing[4],
    right: theme.spacing[4],
    bottom: theme.spacing[4],
    alignItems: "center",
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    ...theme.shadow.md,
  },
  zoomLevelButton: {
    minWidth: 56,
  },
}));

import { encodeAttachmentsForSend } from "@/attachments/service";
import type { AttachmentMetadata } from "@/attachments/types";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  type ActionStatus,
} from "@/components/ui/context-menu";
import { useToast } from "@/contexts/toast-context";
import type { Theme } from "@/styles/theme";
import * as Clipboard from "expo-clipboard";
import * as MediaLibrary from "expo-media-library";
import * as Sharing from "expo-sharing";
import { Copy, ImageDown, Share2 } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import {
  Image,
  Platform,
  StyleSheet,
  View,
  type AccessibilityActionEvent,
  type LayoutChangeEvent,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { withUnistyles } from "react-native-unistyles";
import {
  clampImageTranslation,
  containImageSize,
  getDoubleTapImageScale,
  resetImageTransform,
  zoomImageAroundPoint,
  type ImagePreviewSize,
} from "./image-preview-geometry";
import {
  savePreviewImage,
  sharePreviewImage,
  type ImagePreviewActionPort,
} from "./image-preview-actions";

export interface FileImagePreviewProps {
  uri: string;
  fileName: string;
  attachment: AttachmentMetadata | null;
}

const ThemedCopy = withUnistyles(Copy);
const ThemedSave = withUnistyles(ImageDown);
const ThemedShare = withUnistyles(Share2);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const EMPTY_SIZE: ImagePreviewSize = { width: 0, height: 0 };
const nativeImageActions: ImagePreviewActionPort = {
  async requestSavePermission() {
    return (await MediaLibrary.requestPermissionsAsync(true, [])).granted;
  },
  saveToPhotoLibrary: MediaLibrary.saveToLibraryAsync,
  async share({ uri, mimeType, fileName }) {
    if (!(await Sharing.isAvailableAsync())) {
      throw new Error("Sharing is unavailable");
    }
    await Sharing.shareAsync(uri, { mimeType, dialogTitle: fileName });
  },
};

export function FileImagePreview({ uri, fileName, attachment }: FileImagePreviewProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const [menuOpen, setMenuOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState<ActionStatus>("idle");
  const [saveStatus, setSaveStatus] = useState<ActionStatus>("idle");
  const [viewport, setViewport] = useState<ImagePreviewSize>(EMPTY_SIZE);
  const [image, setImage] = useState<ImagePreviewSize>(EMPTY_SIZE);
  const shareTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const content = useMemo(() => containImageSize(image, viewport), [image, viewport]);
  const imageSource = useMemo(() => ({ uri }), [uri]);

  const scale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const pinchStartScale = useSharedValue(1);
  const pinchStartX = useSharedValue(0);
  const pinchStartY = useSharedValue(0);
  const panStartX = useSharedValue(0);
  const panStartY = useSharedValue(0);
  const touchStartX = useSharedValue(0);
  const touchStartY = useSharedValue(0);

  useEffect(() => {
    const reset = resetImageTransform();
    scale.value = reset.scale;
    translateX.value = reset.translation.x;
    translateY.value = reset.translation.y;
    setImage(EMPTY_SIZE);
  }, [scale, translateX, translateY, uri]);

  useEffect(
    () => () => {
      if (shareTimerRef.current) clearTimeout(shareTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    const translation = clampImageTranslation({
      translation: { x: translateX.value, y: translateY.value },
      scale: scale.value,
      content,
      viewport,
    });
    translateX.value = translation.x;
    translateY.value = translation.y;
  }, [content, scale, translateX, translateY, viewport]);

  const gesture = useMemo(() => {
    const pinch = Gesture.Pinch()
      .onStart(() => {
        pinchStartScale.value = scale.value;
        pinchStartX.value = translateX.value;
        pinchStartY.value = translateY.value;
      })
      .onUpdate((event) => {
        const next = zoomImageAroundPoint({
          scale: pinchStartScale.value,
          translation: { x: pinchStartX.value, y: pinchStartY.value },
          targetScale: pinchStartScale.value * event.scale,
          focal: { x: event.focalX, y: event.focalY },
          content,
          viewport,
        });
        scale.value = next.scale;
        translateX.value = next.translation.x;
        translateY.value = next.translation.y;
      });

    const pan = Gesture.Pan()
      .manualActivation(true)
      .onTouchesDown((event) => {
        const touch = event.changedTouches[0];
        if (touch) {
          touchStartX.value = touch.absoluteX;
          touchStartY.value = touch.absoluteY;
        }
      })
      .onTouchesMove((event, stateManager) => {
        const touch = event.changedTouches[0];
        if (!touch || event.numberOfTouches !== 1 || scale.value <= 1) {
          stateManager.fail();
          return;
        }
        if (
          Math.abs(touch.absoluteX - touchStartX.value) >= 3 ||
          Math.abs(touch.absoluteY - touchStartY.value) >= 3
        ) {
          stateManager.activate();
        }
      })
      .onStart(() => {
        panStartX.value = translateX.value;
        panStartY.value = translateY.value;
      })
      .onUpdate((event) => {
        const next = clampImageTranslation({
          translation: {
            x: panStartX.value + event.translationX,
            y: panStartY.value + event.translationY,
          },
          scale: scale.value,
          content,
          viewport,
        });
        translateX.value = next.x;
        translateY.value = next.y;
      });

    const doubleTap = Gesture.Tap()
      .numberOfTaps(2)
      .maxDuration(250)
      .onEnd((event, success) => {
        if (!success) return;
        const next = zoomImageAroundPoint({
          scale: scale.value,
          translation: { x: translateX.value, y: translateY.value },
          targetScale: getDoubleTapImageScale(scale.value),
          focal: { x: event.x, y: event.y },
          content,
          viewport,
        });
        scale.value = withTiming(next.scale);
        translateX.value = withTiming(next.translation.x);
        translateY.value = withTiming(next.translation.y);
      });

    return Gesture.Simultaneous(pinch, pan, doubleTap);
  }, [
    content,
    panStartX,
    panStartY,
    pinchStartScale,
    pinchStartX,
    pinchStartY,
    scale,
    touchStartX,
    touchStartY,
    translateX,
    translateY,
    viewport,
  ]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setViewport({ width, height });
  }, []);
  const handleImageLoad = useCallback<NonNullable<ComponentProps<typeof Image>["onLoad"]>>(
    (event) => {
      const { width, height } = event.nativeEvent.source;
      setImage({ width, height });
    },
    [],
  );

  const handleCopyImage = useCallback(async () => {
    if (!attachment || copyStatus === "pending") return;
    setCopyStatus("pending");
    try {
      const encoded = await encodeAttachmentsForSend([attachment]);
      const base64 = encoded?.[0]?.data;
      if (!base64) throw new Error("Image encoding failed");
      await Clipboard.setImageAsync(base64);
      setMenuOpen(false);
      setCopyStatus("idle");
      toast.copied();
    } catch {
      setCopyStatus("idle");
      toast.error(t("panels.file.image.copyFailed"));
    }
  }, [attachment, copyStatus, t, toast]);

  const handleSaveImage = useCallback(async () => {
    if (saveStatus === "pending") return;
    setSaveStatus("pending");
    try {
      const result = await savePreviewImage(uri, nativeImageActions);
      if (result === "permission-denied") {
        setSaveStatus("idle");
        toast.error(t("panels.file.image.savePermissionDenied"));
        return;
      }
      setSaveStatus("success");
      setMenuOpen(false);
      toast.show(t("panels.file.image.saved"), { variant: "success" });
      setSaveStatus("idle");
    } catch {
      setSaveStatus("idle");
      toast.error(t("panels.file.image.saveFailed"));
    }
  }, [saveStatus, t, toast, uri]);

  const shareImage = useCallback(async () => {
    try {
      await sharePreviewImage(
        { uri, mimeType: attachment?.mimeType ?? "image/*", fileName },
        nativeImageActions,
      );
    } catch {
      toast.error(t("panels.file.image.shareFailed"));
    }
  }, [attachment?.mimeType, fileName, t, toast, uri]);

  const handleShareImage = useCallback(() => {
    setMenuOpen(false);
    if (shareTimerRef.current) clearTimeout(shareTimerRef.current);
    shareTimerRef.current = setTimeout(
      () => {
        shareTimerRef.current = null;
        void shareImage();
      },
      Platform.OS === "ios" ? 250 : 0,
    );
  }, [shareImage]);

  const handleAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === "copyImage") {
        void handleCopyImage();
      } else if (event.nativeEvent.actionName === "saveImage") {
        void handleSaveImage();
      } else if (event.nativeEvent.actionName === "shareImage") {
        void shareImage();
      }
    },
    [handleCopyImage, handleSaveImage, shareImage],
  );
  const handleSelectCopyImage = useCallback(() => void handleCopyImage(), [handleCopyImage]);
  const handleSelectSaveImage = useCallback(() => void handleSaveImage(), [handleSaveImage]);
  const copyLeading = useMemo(() => <ThemedCopy size={16} uniProps={mutedColorMapping} />, []);
  const saveLeading = useMemo(() => <ThemedSave size={16} uniProps={mutedColorMapping} />, []);
  const shareLeading = useMemo(() => <ThemedShare size={16} uniProps={mutedColorMapping} />, []);

  const imageFrameStyle = useMemo(
    () => ({ width: content.width, height: content.height }),
    [content.height, content.width],
  );

  return (
    <View style={nativeStyles.container}>
      <ContextMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <ContextMenuTrigger
          enabledOnMobile
          enabledOnWeb={false}
          style={nativeStyles.trigger}
          testID="workspace-file-image"
          accessibilityRole="imagebutton"
          accessibilityLabel={t("panels.file.image.accessibilityLabel", { fileName })}
          accessibilityHint={t("panels.file.image.accessibilityHint")}
          accessibilityActions={[
            { name: "copyImage", label: t("panels.file.image.copy") },
            { name: "saveImage", label: t("panels.file.image.save") },
            { name: "shareImage", label: t("workspace.fileActions.share") },
          ]}
          onAccessibilityAction={handleAccessibilityAction}
        >
          <GestureDetector gesture={gesture}>
            <View collapsable={false} style={nativeStyles.viewport} onLayout={handleLayout}>
              {content.width > 0 && content.height > 0 ? (
                <Animated.View style={[nativeStyles.imageFrame, imageFrameStyle, animatedStyle]}>
                  <Image
                    source={imageSource}
                    resizeMode="contain"
                    style={nativeStyles.image}
                    onLoad={handleImageLoad}
                  />
                </Animated.View>
              ) : (
                <Image
                  source={imageSource}
                  resizeMode="contain"
                  style={nativeStyles.image}
                  onLoad={handleImageLoad}
                />
              )}
            </View>
          </GestureDetector>
        </ContextMenuTrigger>
        <ContextMenuContent align="center" mobileMode="dropdown" testID="file-image-actions-menu">
          <ContextMenuItem
            closeOnSelect={false}
            disabled={!attachment}
            status={copyStatus}
            pendingLabel={t("panels.file.image.copying")}
            leading={copyLeading}
            onSelect={handleSelectCopyImage}
          >
            {t("panels.file.image.copy")}
          </ContextMenuItem>
          <ContextMenuItem
            closeOnSelect={false}
            status={saveStatus}
            pendingLabel={t("panels.file.image.saving")}
            successLabel={t("panels.file.image.saved")}
            leading={saveLeading}
            onSelect={handleSelectSaveImage}
          >
            {t("panels.file.image.save")}
          </ContextMenuItem>
          <ContextMenuItem closeOnSelect={false} leading={shareLeading} onSelect={handleShareImage}>
            {t("workspace.fileActions.share")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </View>
  );
}

const nativeStyles = StyleSheet.create({
  container: {
    flex: 1,
    minHeight: 0,
  },
  trigger: {
    flex: 1,
    minHeight: 0,
    margin: 16,
    overflow: "hidden",
  },
  viewport: {
    flex: 1,
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
});

import { getFileExtension, getRasterImageMimeTypeFromPath } from "@/attachments/file-types";
import { generateAttachmentId } from "@/attachments/utils";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  type ActionStatus,
} from "@/components/ui/context-menu";
import { ZoomableImage } from "@/components/zoomable-viewport/image";
import { useToast } from "@/contexts/toast-context";
import type { Theme } from "@/styles/theme";
import * as Clipboard from "expo-clipboard";
import * as FileSystem from "expo-file-system/legacy";
import * as MediaLibrary from "expo-media-library";
import * as Sharing from "expo-sharing";
import { Copy, ImageDown, Share2 } from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View, type AccessibilityActionEvent } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { savePreviewImage, type ImagePreviewLibrary } from "./save";
import type { ImagePreviewProps } from "./view";

const ThemedCopy = withUnistyles(Copy);
const ThemedSave = withUnistyles(ImageDown);
const ThemedShare = withUnistyles(Share2);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const imageLibrary: ImagePreviewLibrary = {
  async requestSavePermission() {
    return (await MediaLibrary.requestPermissionsAsync(true, [])).granted;
  },
  saveToPhotoLibrary: MediaLibrary.saveToLibraryAsync,
};

async function withLocalImage(uri: string, action: (localUri: string) => Promise<void>) {
  if (!/^https?:\/\//i.test(uri)) {
    await action(uri);
    return;
  }
  if (!FileSystem.cacheDirectory) throw new Error("Image cache is unavailable");
  const extension = getFileExtension(uri) || ".png";
  const target = `${FileSystem.cacheDirectory}${generateAttachmentId()}${extension}`;
  try {
    const download = await FileSystem.downloadAsync(uri, target);
    if (download.status < 200 || download.status >= 300) {
      throw new Error(`Image download failed: ${download.status}`);
    }
    await action(download.uri);
  } finally {
    await FileSystem.deleteAsync(target, { idempotent: true });
  }
}

export function ImagePreview({
  uri,
  fileName,
  attachment,
  accessibilityLabel,
  style,
  testID = "image-file-preview",
  ...props
}: ImagePreviewProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const [menuOpen, setMenuOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState<ActionStatus>("idle");
  const [saveStatus, setSaveStatus] = useState<ActionStatus>("idle");
  const [shareStatus, setShareStatus] = useState<ActionStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const handleMenuOpenChange = useCallback((open: boolean) => {
    setMenuOpen(open);
    if (!open) setError(null);
  }, []);

  const copyImage = useCallback(async () => {
    if (copyStatus === "pending") return;
    setCopyStatus("pending");
    setError(null);
    try {
      await withLocalImage(uri, async (localUri) => {
        const base64 = await FileSystem.readAsStringAsync(localUri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        await Clipboard.setImageAsync(base64);
      });
      setMenuOpen(false);
      toast.copied();
    } catch {
      setError(t("panels.file.image.copyFailed"));
    } finally {
      setCopyStatus("idle");
    }
  }, [uri, copyStatus, t, toast]);

  const saveImage = useCallback(async () => {
    if (saveStatus === "pending") return;
    setSaveStatus("pending");
    setError(null);
    try {
      await withLocalImage(uri, async (localUri) => {
        const result = await savePreviewImage(localUri, imageLibrary);
        if (result === "permission-denied") {
          setError(t("panels.file.image.savePermissionDenied"));
          return;
        }
        setMenuOpen(false);
        toast.show(t("panels.file.image.saved"), { variant: "success" });
      });
    } catch {
      setError(t("panels.file.image.saveFailed"));
    } finally {
      setSaveStatus("idle");
    }
  }, [saveStatus, t, toast, uri]);

  const shareImage = useCallback(async () => {
    if (shareStatus === "pending") return;
    setShareStatus("pending");
    setError(null);
    try {
      if (!(await Sharing.isAvailableAsync())) {
        throw new Error("Sharing is unavailable");
      }
      await withLocalImage(uri, async (localUri) => {
        await Sharing.shareAsync(localUri, {
          mimeType: attachment?.mimeType ?? getRasterImageMimeTypeFromPath(uri) ?? "image/*",
          dialogTitle: fileName,
        });
      });
      setMenuOpen(false);
    } catch {
      setError(t("panels.file.image.shareFailed"));
    } finally {
      setShareStatus("idle");
    }
  }, [attachment?.mimeType, fileName, shareStatus, t, uri]);

  const handleAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === "copyImage") {
        void copyImage();
      } else if (event.nativeEvent.actionName === "saveImage") {
        void saveImage();
      } else if (event.nativeEvent.actionName === "shareImage") {
        void shareImage();
      }
    },
    [copyImage, saveImage, shareImage],
  );
  const handleCopy = useCallback(() => void copyImage(), [copyImage]);
  const handleSave = useCallback(() => void saveImage(), [saveImage]);
  const handleShare = useCallback(() => void shareImage(), [shareImage]);
  const copyLeading = useMemo(() => <ThemedCopy size={16} uniProps={mutedColorMapping} />, []);
  const saveLeading = useMemo(() => <ThemedSave size={16} uniProps={mutedColorMapping} />, []);
  const shareLeading = useMemo(() => <ThemedShare size={16} uniProps={mutedColorMapping} />, []);

  return (
    <View style={[styles.container, style]}>
      <ContextMenu open={menuOpen} onOpenChange={handleMenuOpenChange} compactMode="popover">
        <ContextMenuTrigger
          enabledOnMobile
          style={styles.trigger}
          testID={`${testID}-actions`}
          accessibilityRole="imagebutton"
          accessibilityLabel={
            accessibilityLabel ?? t("panels.file.image.accessibilityLabel", { fileName })
          }
          accessibilityHint={t("panels.file.image.accessibilityHint")}
          accessibilityActions={[
            { name: "copyImage", label: t("panels.file.image.copy") },
            { name: "saveImage", label: t("panels.file.image.save") },
            { name: "shareImage", label: t("panels.file.image.share") },
          ]}
          onAccessibilityAction={handleAccessibilityAction}
        >
          <ZoomableImage
            {...props}
            accessibilityLabel={
              accessibilityLabel ?? t("panels.file.image.accessibilityLabel", { fileName })
            }
            style={styles.viewport}
            testID={testID}
            uri={uri}
          />
        </ContextMenuTrigger>
        <ContextMenuContent align="center" testID={`${testID}-actions-menu`}>
          <ContextMenuItem
            closeOnSelect={false}
            status={copyStatus}
            pendingLabel={t("panels.file.image.copying")}
            leading={copyLeading}
            onSelect={handleCopy}
          >
            {t("panels.file.image.copy")}
          </ContextMenuItem>
          <ContextMenuItem
            closeOnSelect={false}
            status={saveStatus}
            pendingLabel={t("panels.file.image.saving")}
            leading={saveLeading}
            onSelect={handleSave}
          >
            {t("panels.file.image.save")}
          </ContextMenuItem>
          <ContextMenuItem
            closeOnSelect={false}
            status={shareStatus}
            pendingLabel={t("panels.file.image.sharing")}
            leading={shareLeading}
            onSelect={handleShare}
          >
            {t("panels.file.image.share")}
          </ContextMenuItem>
          {error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          ) : null}
        </ContextMenuContent>
      </ContextMenu>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
  },
  trigger: {
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
  },
  viewport: {
    flex: 1,
    minHeight: 0,
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[3],
  },
}));

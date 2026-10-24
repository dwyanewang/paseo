import type { AttachmentMetadata } from "@/attachments/types";
import { ZoomableImage } from "@/components/zoomable-viewport/image";
import type { ComponentProps } from "react";
import { useTranslation } from "react-i18next";

export interface ImagePreviewProps extends ComponentProps<typeof ZoomableImage> {
  fileName: string;
  attachment: AttachmentMetadata | null;
}

export function ImagePreview({
  fileName,
  attachment: _attachment,
  accessibilityLabel,
  testID = "image-file-preview",
  ...props
}: ImagePreviewProps) {
  const { t } = useTranslation();
  return (
    <ZoomableImage
      {...props}
      accessibilityLabel={
        accessibilityLabel ?? t("panels.file.image.accessibilityLabel", { fileName })
      }
      testID={testID}
    />
  );
}

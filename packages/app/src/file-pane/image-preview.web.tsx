import type { AttachmentMetadata } from "@/attachments/types";
import { useMemo } from "react";
import { Image, ScrollView, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export interface FileImagePreviewProps {
  uri: string;
  fileName: string;
  attachment: AttachmentMetadata | null;
  onDownload: () => void;
}

export function FileImagePreview({ uri, fileName }: FileImagePreviewProps) {
  const source = useMemo(() => ({ uri }), [uri]);
  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator
      >
        <Image
          accessibilityLabel={fileName}
          source={source}
          style={styles.image}
          resizeMode="contain"
        />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  scrollContent: {
    flexGrow: 1,
    padding: theme.spacing[4],
    alignItems: "center",
    justifyContent: "center",
  },
  image: {
    width: "100%",
    height: 420,
  },
}));

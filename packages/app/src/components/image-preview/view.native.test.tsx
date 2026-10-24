/**
 * @vitest-environment jsdom
 */
import React from "react";
import { en } from "@/i18n/resources/en";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImagePreview } from "./view.native";

const native = vi.hoisted(() => ({
  requestPermissions: vi.fn(async () => ({ granted: true })),
  saveToLibrary: vi.fn(async (_uri: string) => {}),
  download: vi.fn(async (_uri: string, target: string) => ({ uri: target, status: 200 })),
  deleteFile: vi.fn(async () => {}),
  share: vi.fn(async () => {}),
  copy: vi.fn(async () => {}),
  toast: { show: vi.fn(), copied: vi.fn(), error: vi.fn() },
}));

// These APIs have no device implementation in Node. Keep the menu and its operation state real.
vi.mock("expo-media-library/legacy", () => ({
  requestPermissionsAsync: native.requestPermissions,
  saveToLibraryAsync: native.saveToLibrary,
}));
vi.mock("expo-file-system/legacy", () => ({
  cacheDirectory: "file:///cache/",
  EncodingType: { Base64: "base64" },
  readAsStringAsync: async () => "aW1hZ2U=",
  downloadAsync: native.download,
  deleteAsync: native.deleteFile,
}));
vi.mock("expo-clipboard", () => ({ setImageAsync: native.copy }));
vi.mock("expo-sharing", () => ({
  isAvailableAsync: async () => true,
  shareAsync: native.share,
}));
vi.mock("@/contexts/toast-context", () => ({ useToast: () => native.toast }));
vi.mock("@/components/zoomable-viewport/image", () => ({
  ZoomableImage: () => <div role="img" aria-label="Preview" />,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const label = key.split(".").at(-1);
      return Reflect.get(en.panels.file.image, label ?? "") ?? key;
    },
  }),
}));

function openMenu() {
  fireEvent.contextMenu(screen.getByLabelText("Preview image"), {
    clientX: 120,
    clientY: 200,
  });
}

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPreview(uri = "file:///cache/chat-image.png") {
  render(
    <ImagePreview
      uri={uri}
      attachment={null}
      fileName="chat-image.png"
      accessibilityLabel="Preview image"
      testID="attachment-lightbox"
    />,
  );
  openMenu();
}

describe("native image preview actions", () => {
  it("saves a chat image without attachment metadata and keeps the preview open", async () => {
    renderPreview();
    fireEvent.click(await screen.findByText("Save to photos"));

    await waitFor(() =>
      expect(native.saveToLibrary).toHaveBeenCalledWith("file:///cache/chat-image.png"),
    );
    await waitFor(() =>
      expect(native.toast.show).toHaveBeenCalledWith("Saved to photos", { variant: "success" }),
    );
    expect(screen.getByRole("img", { name: "Preview" })).not.toBeNull();
    expect(screen.queryByText("Save to photos")).toBeNull();
  });

  it("shows a save failure in the menu and allows retrying", async () => {
    native.saveToLibrary.mockRejectedValueOnce(new Error("write failed"));
    renderPreview();
    fireEvent.click(await screen.findByText("Save to photos"));

    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Failed to save image");
    fireEvent.click(screen.getByText("Save to photos"));
    await waitFor(() => expect(native.saveToLibrary).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("explains denied photo access without attempting to save", async () => {
    native.requestPermissions.mockResolvedValueOnce({ granted: false });
    renderPreview();
    fireEvent.click(await screen.findByText("Save to photos"));

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Allow photo access to save this image",
    );
    expect(native.saveToLibrary).not.toHaveBeenCalled();
    expect(screen.getByText("Save to photos")).not.toBeNull();
  });

  it("keeps the saving state visible until the operation finishes", async () => {
    let completeSave: () => void = () => {};
    native.saveToLibrary.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          completeSave = resolve;
        }),
    );
    renderPreview();
    fireEvent.click(await screen.findByText("Save to photos"));

    expect(await screen.findByText("Saving image...")).not.toBeNull();
    await act(async () => completeSave());
    await waitFor(() => expect(screen.queryByText("Saving image...")).toBeNull());
    expect(native.saveToLibrary).toHaveBeenCalledTimes(1);
  });

  it("downloads a remote chat image before saving it, then removes the temporary file", async () => {
    renderPreview("https://example.com/chat-image.png");
    fireEvent.click(await screen.findByText("Save to photos"));

    await waitFor(() => expect(native.saveToLibrary).toHaveBeenCalledTimes(1));
    const localUri = native.saveToLibrary.mock.calls[0]?.[0];
    expect(localUri).toMatch(/^file:\/\/\/cache\/att_.+\.png$/);
    expect(native.download).toHaveBeenCalledWith("https://example.com/chat-image.png", localUri);
    await waitFor(() =>
      expect(native.deleteFile).toHaveBeenCalledWith(localUri, { idempotent: true }),
    );
  });

  it("copies a chat image without attachment metadata", async () => {
    renderPreview();
    fireEvent.click(await screen.findByText("Copy image"));

    await waitFor(() => expect(native.copy).toHaveBeenCalledWith("aW1hZ2U="));
    expect(native.toast.copied).toHaveBeenCalledTimes(1);
  });

  it("keeps remote download failures in the menu without saving an error response", async () => {
    native.download.mockImplementationOnce(async (_uri, target) => ({ uri: target, status: 404 }));
    renderPreview("https://example.com/missing.png");
    fireEvent.click(await screen.findByText("Save to photos"));

    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Failed to save image");
    expect(native.saveToLibrary).not.toHaveBeenCalled();
    expect(native.deleteFile).toHaveBeenCalledTimes(1);
  });

  it("shows copy failures in the menu", async () => {
    native.copy.mockRejectedValueOnce(new Error("clipboard unavailable"));
    renderPreview();
    fireEvent.click(await screen.findByText("Copy image"));

    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Failed to copy image");
    expect(screen.getByText("Copy image")).not.toBeNull();
  });

  it("shares a chat image without attachment metadata", async () => {
    renderPreview();
    fireEvent.click(await screen.findByText("Share image"));

    await waitFor(() =>
      expect(native.share).toHaveBeenCalledWith("file:///cache/chat-image.png", {
        mimeType: "image/png",
        dialogTitle: "chat-image.png",
      }),
    );
  });

  it("shows share failures in the menu", async () => {
    native.share.mockRejectedValueOnce(new Error("share unavailable"));
    renderPreview();
    fireEvent.click(await screen.findByText("Share image"));

    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Failed to share image");
    expect(screen.getByText("Share image")).not.toBeNull();
  });
});

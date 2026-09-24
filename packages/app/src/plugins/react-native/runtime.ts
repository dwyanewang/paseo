import { Icon } from "../icons";
import { Modal } from "./modal";
import { Overlay } from "./overlay";
import { ScrollView, FlatList } from "./scroll-view";
import { TextInput } from "./text-input";
import { copyText } from "./clipboard";
import { pickImages } from "./image-picker";
import { useToast } from "./toast";
import { useRevealedText } from "@/hooks/use-revealed-text";

export const pluginReactNativeRuntime = {
  Icon,
  Modal,
  Overlay,
  ScrollView,
  FlatList,
  TextInput,
  copyText,
  pickImages,
  useRevealedText,
  useToast,
};

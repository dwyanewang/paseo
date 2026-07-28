import { CodeupIcon } from "@/components/icons/codeup-icon";
import type { ClientForgeViewModule } from "@/git/client-forge-module";

export const codeupForgeView = {
  id: "codeup",
  icon: CodeupIcon,
  brandColor: {
    light: "#FF6A00",
    dark: "#FF6A00",
  },
} satisfies ClientForgeViewModule;

import { useMemo, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { ComboboxItem, type ComboboxOption } from "@/components/ui/combobox";
import { Shortcut } from "@/components/ui/shortcut";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { getHostProjectSourceDirectory, type HostProjectListItem } from "@/projects/host-projects";
import type { PickerItem } from "../../new-workspace-picker-item";
import {
  addProjectIcon,
  branchIcon,
  ProjectIcon,
  pullRequestIcon,
  workspaceModeIcon,
} from "./icons";

interface OptionRowState {
  option: ComboboxOption;
  selected: boolean;
  active: boolean;
  onPress: () => void;
}

function IconBox({ children }: { children: ReactElement }): ReactElement {
  return <View style={styles.iconBox}>{children}</View>;
}

export function ProjectOption({
  option,
  selected,
  active,
  onPress,
  project,
  iconDataUri,
  selectedServerId,
  disabled,
}: OptionRowState & {
  project: HostProjectListItem | undefined;
  iconDataUri: string | null;
  selectedServerId: string;
  disabled: boolean;
}): ReactElement {
  const leadingSlot = useMemo(
    () =>
      project ? (
        <IconBox>
          <ProjectIcon
            projectViewKey={project.viewKey}
            projectName={project.projectName}
            iconDataUri={iconDataUri}
          />
        </IconBox>
      ) : undefined,
    [iconDataUri, project],
  );
  if (!project) return <View key={option.id} />;
  return (
    <ComboboxItem
      testID={`new-workspace-project-picker-option-${project.viewKey}`}
      label={project.projectName}
      description={
        getHostProjectSourceDirectory(project, selectedServerId) ?? project.iconWorkingDir
      }
      selected={selected}
      active={active}
      disabled={disabled}
      onPress={onPress}
      leadingSlot={leadingSlot}
    />
  );
}

export function AddProjectOption({ onPress }: { onPress: () => void }): ReactElement {
  const { t } = useTranslation();
  const openProjectKeys = useShortcutKeys("new-agent");
  const shortcut = useMemo(
    () => (openProjectKeys ? <Shortcut chord={openProjectKeys} /> : null),
    [openProjectKeys],
  );
  return (
    <ComboboxItem
      testID="new-workspace-project-picker-add-project"
      label={t("sidebar.actions.addProject")}
      onPress={onPress}
      leadingSlot={addProjectIcon}
      trailingSlot={shortcut}
    />
  );
}

export function WorkspaceModeOption({
  option,
  selected,
  active,
  onPress,
  disabled,
  description,
}: OptionRowState & { disabled: boolean; description?: string }): ReactElement {
  const leadingSlot = useMemo(() => <IconBox>{workspaceModeIcon(option.id)}</IconBox>, [option.id]);
  return (
    <ComboboxItem
      testID={`workspace-create-mode-${option.id}`}
      label={option.label}
      selected={selected}
      active={active}
      disabled={disabled}
      onPress={onPress}
      leadingSlot={leadingSlot}
      description={description}
    />
  );
}

const branchLeading = <IconBox>{branchIcon}</IconBox>;
const pullRequestLeading = <IconBox>{pullRequestIcon}</IconBox>;

export function RefOption({
  option,
  selected,
  active,
  onPress,
  item,
  disabled,
  changeRequestBranchOffDisabled,
}: OptionRowState & {
  item: PickerItem | undefined;
  disabled: boolean;
  changeRequestBranchOffDisabled: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const divergenceLabel = item?.kind === "branch" ? item.divergenceLabel : undefined;
  const trailingSlot = useMemo(
    () =>
      divergenceLabel ? <Text style={styles.divergenceLabel}>{divergenceLabel}</Text> : undefined,
    [divergenceLabel],
  );
  if (!item) return <View key={option.id} />;

  const isBranch = item.kind === "branch";
  let description: string | undefined;
  if (!isBranch && changeRequestBranchOffDisabled) {
    description = t("newWorkspace.branchMode.updateHost");
  } else if (!isBranch && item.item.baseRefName) {
    description = t("newWorkspace.refPicker.intoBase", { baseRef: item.item.baseRefName });
  }
  return (
    <ComboboxItem
      testID={
        isBranch
          ? `new-workspace-ref-picker-branch-${item.name}`
          : `new-workspace-ref-picker-pr-${item.item.number}`
      }
      label={option.label}
      description={description}
      selected={selected}
      active={active}
      disabled={disabled || (!isBranch && changeRequestBranchOffDisabled)}
      onPress={onPress}
      leadingSlot={isBranch ? branchLeading : pullRequestLeading}
      trailingSlot={trailingSlot}
      accessibilityLabel={isBranch ? item.accessibilityLabel : undefined}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  iconBox: {
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    alignItems: "center",
    justifyContent: "center",
  },
  divergenceLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontVariant: ["tabular-nums"],
  },
}));

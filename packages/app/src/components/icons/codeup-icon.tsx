import { SvgPathIcon, type SvgPathIconProps } from "./svg-path-icon";

// Monochrome form of Codeup's circular C mark. The view module applies the
// official Alibaba Cloud orange brand treatment at call sites.
const CODEUP_ICON_PATH =
  "M12 1.5A10.5 10.5 0 1 0 20.07 18.72l-3.18-3.18A6 6 0 1 1 16.31 8l3.62-2.72A10.47 10.47 0 0 0 12 1.5Zm7.5 2.25a2.25 2.25 0 1 0 0 4.5 2.25 2.25 0 0 0 0-4.5Z";

export function CodeupIcon(props: SvgPathIconProps) {
  return <SvgPathIcon {...props} viewBox="0 0 24 24" path={CODEUP_ICON_PATH} />;
}

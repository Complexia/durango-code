import type { SVGProps } from 'react';
import orionIconUrl from '../assets/icon.png';

export type ProviderIconProps = SVGProps<SVGSVGElement> & {
  size?: number;
};

const iconProps = (size: number, className?: string): ProviderIconProps => ({
  width: size,
  height: size,
  className,
  'aria-hidden': true,
});

/** Grok app mark (rounded square + black-hole symbol) */
export const GrokBrandIcon = ({ size = 24, className, ...props }: ProviderIconProps) => (
  <svg
    viewBox="0 0 512 509.641"
    fillRule="evenodd"
    clipRule="evenodd"
    className={['grok-brand-icon', className].filter(Boolean).join(' ')}
    width={size}
    height={size}
    aria-hidden
    {...props}
  >
    <path
      fill="#000"
      d="M115.612 0h280.776C459.975 0 512 52.026 512 115.612v278.416c0 63.587-52.025 115.613-115.612 115.613H115.612C52.026 509.641 0 457.615 0 394.028V115.612C0 52.026 52.026 0 115.612 0z"
    />
    <path
      fill="#fff"
      d="M213.235 306.019l178.976-180.002v.169l51.695-51.763c-.924 1.32-1.86 2.605-2.785 3.89-39.281 54.164-58.46 80.649-43.07 146.922l-.09-.101c10.61 45.11-.744 95.137-37.398 131.836-46.216 46.306-120.167 56.611-181.063 14.928l42.462-19.675c38.863 15.278 81.392 8.57 111.947-22.03 30.566-30.6 37.432-75.159 22.065-112.252-2.92-7.025-11.67-8.795-17.792-4.263l-124.947 92.341zm-25.786 22.437l-.033.034L68.094 435.217c7.565-10.429 16.957-20.294 26.327-30.149 26.428-27.803 52.653-55.359 36.654-94.302-21.422-52.112-8.952-113.177 30.724-152.898 41.243-41.254 101.98-51.661 152.706-30.758 11.23 4.172 21.016 10.114 28.638 15.639l-42.359 19.584c-39.44-16.563-84.629-5.299-112.207 22.313-37.298 37.308-44.84 102.003-1.128 143.81z"
    />
  </svg>
);

/** OpenAI / Codex mark */
export const CodexBrandIcon = ({ size = 24, className, ...props }: ProviderIconProps) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...iconProps(size, className)} {...props}>
    <path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 0 0-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 0 1 .476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 0 1 4.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 0 1-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 0 0 5.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0 0 10.205 0a5.947 5.947 0 0 0-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 0 0 4.162 1.713z" />
  </svg>
);

/** Anthropic / Claude mark */
export const ClaudeBrandIcon = ({ size = 24, className, ...props }: ProviderIconProps) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...iconProps(size, className)} {...props}>
    <path d="M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017l-1.344 3.46H0L6.57 3.522zm4.132 9.959L8.453 7.687 6.205 13.48H10.7z" />
  </svg>
);

/** Cursor IDE mark */
export const CursorBrandIcon = ({ size = 24, className, ...props }: ProviderIconProps) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...iconProps(size, className)} {...props}>
    <path d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23" />
  </svg>
);

/** Moonshot AI / Kimi mark (rounded square + K glyph) */
export const KimiBrandIcon = ({ size = 24, className, ...props }: ProviderIconProps) => (
  <svg
    viewBox="0 0 24 24"
    fill="currentColor"
    fillRule="evenodd"
    clipRule="evenodd"
    {...iconProps(size, className)}
    {...props}
  >
    <path d="M5.4 0h13.2A5.4 5.4 0 0 1 24 5.4v13.2a5.4 5.4 0 0 1-5.4 5.4H5.4A5.4 5.4 0 0 1 0 18.6V5.4A5.4 5.4 0 0 1 5.4 0zm1.85 4.75h2.9v6.02l5.53-6.02h3.72l-5.6 6.06 5.86 8.44h-3.54l-4.26-6.24-1.71 1.84v4.4h-2.9V4.75z" />
  </svg>
);

/** Meta / Muse Code mark (Meta infinity-loop logo) */
export const MuseBrandIcon = ({ size = 24, className, ...props }: ProviderIconProps) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...iconProps(size, className)} {...props}>
    <path d="M6.915 4.03c-1.968 0-3.683 1.28-4.871 3.113C.704 9.208 0 11.883 0 14.449c0 .706.07 1.369.21 1.973a6.624 6.624 0 0 0 .265.86 5.297 5.297 0 0 0 .371.761c.696 1.159 1.818 1.927 3.593 1.927 1.497 0 2.633-.671 3.965-2.444.76-1.012 1.144-1.626 2.663-4.32l.756-1.339.186-.325c.061.1.121.196.183.3l2.152 3.595c.724 1.21 1.665 2.556 2.47 3.314 1.046.987 1.992 1.22 3.06 1.22 1.075 0 1.876-.355 2.455-.843a3.743 3.743 0 0 0 .81-.973c.542-.939.861-2.127.861-3.745 0-2.72-.681-5.357-2.084-7.45-1.282-1.912-2.957-2.93-4.716-2.93-1.047 0-2.088.467-3.053 1.308-.652.57-1.257 1.29-1.82 2.05-.69-.875-1.335-1.547-1.958-2.056-1.182-.966-2.315-1.303-3.454-1.303zm10.16 2.053c1.147 0 2.188.758 2.992 1.999 1.132 1.748 1.647 4.195 1.647 6.4 0 1.548-.368 2.9-1.839 2.9-.58 0-1.027-.23-1.664-1.004-.496-.601-1.343-1.878-2.832-4.358l-.617-1.028a44.908 44.908 0 0 0-1.255-1.98c.07-.109.141-.224.211-.327 1.12-1.667 2.118-2.602 3.358-2.602zm-10.201.553c1.265 0 2.058.791 2.675 1.446.307.327.737.871 1.234 1.579l-1.02 1.566c-.757 1.163-1.882 3.017-2.837 4.338-1.191 1.649-1.81 1.817-2.486 1.817-.524 0-1.038-.237-1.383-.794-.263-.426-.464-1.13-.464-2.046 0-2.221.63-4.535 1.66-6.088.454-.687.964-1.226 1.533-1.533a2.264 2.264 0 0 1 1.088-.285z" />
  </svg>
);

/** OpenCode mark */
export const OpenCodeBrandIcon = ({ size = 24, className, ...props }: ProviderIconProps) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...iconProps(size, className)} {...props}>
    <path d="M18 20H6V12H18V20Z" opacity="0.45" />
    <path d="M18 8H6V20H18V8ZM24 24H0V0H24V24Z" />
  </svg>
);

/**
 * Durango Code product mark (the app icon, assets/icon.png). The component
 * keeps its internal Orion name. The viewBox crops the icon's transparent
 * margin so the squircle fills small provider/model slots.
 */
export const OrionBrandIcon = ({ size = 24, className, ...props }: ProviderIconProps) => (
  <svg viewBox="88 88 848 848" {...iconProps(size, className)} {...props}>
    <image
      href={orionIconUrl}
      width="1024"
      height="1024"
      preserveAspectRatio="xMidYMid meet"
    />
  </svg>
);

export type ProviderIconComponent = typeof GrokBrandIcon;

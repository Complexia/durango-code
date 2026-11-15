import React, { useMemo } from 'react';
import { DynamicIcon, iconNames, type IconName } from 'lucide-react/dynamic';

/**
 * An icon a theme names: a Lucide icon by name (loaded on demand) or the
 * theme's own inline SVG, rebuilt from an allowlist of shapes and geometry
 * attributes (no scripts, links, styles, foreign content or url()).
 */

const KNOWN_ICONS = new Set<string>(iconNames);
export const isKnownIcon = (name: string | undefined) => Boolean(name && KNOWN_ICONS.has(name));

const SHAPES = new Set(['svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon']);
const ATTRIBUTES: Record<string, string> = {
  d: 'd',
  cx: 'cx',
  cy: 'cy',
  r: 'r',
  rx: 'rx',
  ry: 'ry',
  x: 'x',
  y: 'y',
  x1: 'x1',
  y1: 'y1',
  x2: 'x2',
  y2: 'y2',
  width: 'width',
  height: 'height',
  points: 'points',
  viewbox: 'viewBox',
  fill: 'fill',
  stroke: 'stroke',
  'stroke-width': 'strokeWidth',
  'stroke-linecap': 'strokeLinecap',
  'stroke-linejoin': 'strokeLinejoin',
  'stroke-dasharray': 'strokeDasharray',
  'fill-rule': 'fillRule',
  'clip-rule': 'clipRule',
  opacity: 'opacity',
  'fill-opacity': 'fillOpacity',
  'stroke-opacity': 'strokeOpacity',
  transform: 'transform',
};
const SAFE_VALUE = /^[#a-zA-Z0-9\s.,%()+-]*$/;

type SvgNode = { tag: string; props: Record<string, string>; children: SvgNode[] };

const parseSvg = (markup: string): SvgNode | null => {
  if (typeof DOMParser === 'undefined') return null;
  const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== 'svg' || doc.getElementsByTagName('parsererror').length) return null;
  let count = 0;
  const walk = (element: Element, depth: number): SvgNode | null => {
    const tag = element.nodeName.toLowerCase();
    if (!SHAPES.has(tag) || depth > 8 || ++count > 400) return null;
    const props: Record<string, string> = {};
    for (const attribute of Array.from(element.attributes)) {
      const key = ATTRIBUTES[attribute.name.toLowerCase()];
      const value = attribute.value;
      if (!key || value.length > 4000 || !SAFE_VALUE.test(value) || /url\s*\(/i.test(value)) continue;
      props[key] = value;
    }
    const children = Array.from(element.children)
      .map((child) => walk(child, depth + 1))
      .filter((child): child is SvgNode => Boolean(child));
    return { tag, props, children };
  };
  return walk(root, 0);
};

const renderSvg = (node: SvgNode, key?: number): React.ReactElement =>
  React.createElement(node.tag, { key, ...node.props }, ...node.children.map((child, index) => renderSvg(child, index)));

export const ThemeIcon: React.FC<{ icon?: string; svg?: string; size?: number; className?: string }> = ({ icon, svg, size = 15, className }) => {
  const parsed = useMemo(() => (svg ? parseSvg(svg) : null), [svg]);
  if (parsed) {
    const { width: _width, height: _height, ...rootProps } = parsed.props;
    return React.createElement(
      'svg',
      {
        xmlns: 'http://www.w3.org/2000/svg',
        viewBox: rootProps.viewBox ?? '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        ...rootProps,
        width: size,
        height: size,
        className: `theme-control-icon${className ? ` ${className}` : ''}`,
        'aria-hidden': true,
      },
      ...parsed.children.map((child, index) => renderSvg(child, index))
    );
  }
  if (icon && isKnownIcon(icon)) {
    return <DynamicIcon name={icon as IconName} size={size} className={`theme-control-icon${className ? ` ${className}` : ''}`} aria-hidden />;
  }
  return null;
};

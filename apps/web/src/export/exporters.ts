import monoFontUrl from '@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2?url';
import { circuitBounds } from '@ihatecircuits/core/geometry';
import { serialize } from '@ihatecircuits/core/serialize';
import type { Circuit, Project } from '@ihatecircuits/core/types';
import { imagePdf } from './pdf';

/** Presentation properties copied from computed styles so exports render identically anywhere. */
const STYLE_PROPS = [
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-dasharray',
  'stroke-linecap',
  'stroke-linejoin',
  'opacity',
  'font-size',
  'font-weight',
  'letter-spacing',
] as const;

export const fileSlug = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'circuit';

export function download(data: BlobPart, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function saveProject(p: Project) {
  download(serialize(p), `${fileSlug(p.name)}.json`, 'application/json');
}

let fontCss: Promise<string> | null = null;
/** The mono face as an embedded @font-face, so exported text looks the same without the app. */
function embeddedFont(): Promise<string> {
  fontCss ??= fetch(monoFontUrl)
    .then((r) => r.arrayBuffer())
    .then((buf) => {
      let bin = '';
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return `@font-face{font-family:"Geist Mono";src:url(data:font/woff2;base64,${btoa(bin)}) format("woff2");font-weight:100 900;}`;
    })
    .catch(() => '');
  return fontCss;
}

/**
 * Build a standalone SVG of the circuit from the live canvas. Editor-only
 * layers (pins, selection, hit areas) are dropped and computed styles are
 * inlined in the light theme, so the file needs no stylesheet.
 */
export async function circuitSvg(circuit: Circuit, canvas: SVGSVGElement): Promise<{ svg: string; width: number; height: number } | null> {
  const b = circuitBounds(circuit, 24);
  const world = canvas.querySelector<SVGGElement>('#world');
  if (!b || !world) return null;

  const root = document.documentElement;
  const prevTheme = root.getAttribute('data-theme');
  root.setAttribute('data-theme', 'light');
  try {
    const clone = world.cloneNode(true) as SVGGElement;
    const src = [world, ...world.querySelectorAll('*')];
    const dst = [clone, ...clone.querySelectorAll('*')];
    src.forEach((el, i) => {
      const out = dst[i] as SVGElement;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') {
        out.setAttribute('data-export', 'skip');
        return;
      }
      for (const p of STYLE_PROPS) {
        const v = cs.getPropertyValue(p);
        if (v && v !== 'normal') out.setAttribute(p, v);
      }
      if (el instanceof SVGTextElement) out.setAttribute('font-family', '"Geist Mono", ui-monospace, monospace');
      if (el instanceof SVGForeignObjectElement) out.setAttribute('data-export', 'skip');
      out.removeAttribute('class');
      out.removeAttribute('data-comp');
      out.removeAttribute('data-wire');
      out.removeAttribute('data-poke');
      out.removeAttribute('role');
      out.removeAttribute('aria-label');
    });
    clone.querySelectorAll('[data-export="skip"]').forEach((n) => n.remove());
    clone.removeAttribute('transform');
    clone.removeAttribute('id');
    const bg = getComputedStyle(canvas).getPropertyValue('--surface').trim() || '#ffffff';
    const font = await embeddedFont();
    const width = Math.ceil(b.w);
    const height = Math.ceil(b.h);
    const svg =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${b.x} ${b.y} ${b.w} ${b.h}">` +
      `<title>${escapeXml(circuit.name)}</title>` +
      (font ? `<style>${font}</style>` : '') +
      `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="${bg}"/>` +
      new XMLSerializer().serializeToString(clone).replace(/ xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, '') +
      `</svg>`;
    return { svg, width, height };
  } finally {
    if (prevTheme === null) root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', prevTheme);
  }
}

function escapeXml(s: string) {
  return s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

async function rasterize(svg: string, width: number, height: number, scale: number): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Keep large circuits under a sensible pixel budget. */
const scaleFor = (w: number, h: number, want: number) => Math.max(1, Math.min(want, Math.sqrt(24e6 / (w * h))));

export type ExportFormat = 'svg' | 'png' | 'pdf';

export async function exportCircuit(format: ExportFormat, circuit: Circuit, canvas: SVGSVGElement): Promise<boolean> {
  const built = await circuitSvg(circuit, canvas);
  if (!built) return false;
  const name = fileSlug(circuit.name);
  if (format === 'svg') {
    download(built.svg, `${name}.svg`, 'image/svg+xml');
    return true;
  }
  const scale = scaleFor(built.width, built.height, format === 'png' ? 3 : 4);
  const raster = await rasterize(built.svg, built.width, built.height, scale);
  if (format === 'png') {
    const blob = await new Promise<Blob | null>((res) => raster.toBlob(res, 'image/png'));
    if (!blob) return false;
    download(blob, `${name}.png`, 'image/png');
    return true;
  }
  const { data } = raster.getContext('2d')!.getImageData(0, 0, raster.width, raster.height);
  const rgb = new Uint8Array(raster.width * raster.height * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    rgb[j] = data[i];
    rgb[j + 1] = data[i + 1];
    rgb[j + 2] = data[i + 2];
  }
  // 1 CSS px = 0.75 pt keeps the diagram at its on-screen size.
  const pdf = await imagePdf({ width: raster.width, height: raster.height, rgb, pageWidth: built.width * 0.75, pageHeight: built.height * 0.75, title: circuit.name });
  download(pdf as BlobPart, `${name}.pdf`, 'application/pdf');
  return true;
}

/**
 * Minimal PDF 1.4 writer: one page holding one RGB image.
 * Written from the PDF specification (ISO 32000-1, §7 file structure and
 * §8.9 images); the pixel data is zlib-compressed and stored with FlateDecode.
 */

const enc = new TextEncoder();

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  // CompressionStream('deflate') emits a zlib (RFC 1950) stream, which is what FlateDecode expects.
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface PdfImage {
  /** Pixel size of the image. */
  width: number;
  height: number;
  /** Packed RGB bytes, row-major, 3 bytes per pixel. */
  rgb: Uint8Array;
  /** Page size in PDF points (1/72 inch); the image is scaled to fill it. */
  pageWidth: number;
  pageHeight: number;
  title?: string;
}

const pdfString = (s: string) => `(${s.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, '?')})`;

export async function imagePdf(img: PdfImage): Promise<Uint8Array> {
  if (img.rgb.length !== img.width * img.height * 3) throw new Error('RGB buffer does not match image size');
  const pixels = await deflate(img.rgb);
  const W = round(img.pageWidth);
  const H = round(img.pageHeight);
  const content = enc.encode(`q\n${W} 0 0 ${H} 0 0 cm\n/Im0 Do\nQ\n`);

  const objects: (Uint8Array | string)[][] = [
    ['<< /Type /Catalog /Pages 2 0 R >>'],
    ['<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`],
    [`<< /Length ${content.length} >>\nstream\n`, content, '\nendstream'],
    [
      `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${pixels.length} >>\nstream\n`,
      pixels,
      '\nendstream',
    ],
    [`<< /Title ${pdfString(img.title ?? 'Circuit')} /Producer (iHateCircuits) >>`],
  ];

  const chunks: Uint8Array[] = [];
  let offset = 0;
  const push = (part: Uint8Array | string) => {
    const b = typeof part === 'string' ? enc.encode(part) : part;
    chunks.push(b);
    offset += b.length;
  };
  // A binary comment line tells transfer tools the file is binary.
  push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  const offsets: number[] = [];
  objects.forEach((parts, i) => {
    offsets.push(offset);
    push(`${i + 1} 0 obj\n`);
    parts.forEach(push);
    push('\nendobj\n');
  });
  const xref = offset;
  push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  for (const o of offsets) push(`${String(o).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(offset);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

const round = (n: number) => Math.round(n * 100) / 100;

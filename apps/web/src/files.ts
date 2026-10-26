/**
 * Folder support. Receivers write flat files, so a picked folder is sent as files whose names carry
 * the relative path ("Trip - day1 - photo.jpg"). Hidden/system files are skipped.
 */
const SKIP = /^(\.DS_Store|Thumbs\.db|desktop\.ini)$/i;

export function flattenFolder(files: File[]): File[] {
  const out: File[] = [];
  for (const f of files) {
    if (SKIP.test(f.name)) continue;
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    const flat = rel.split('/').filter(Boolean).join(' - ');
    // new File over an existing File shares the bytes; nothing is read into memory
    out.push(new File([f], flat, { type: f.type, lastModified: f.lastModified }));
  }
  return out;
}

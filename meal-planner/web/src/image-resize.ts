// Phone photos are 3 to 8 MB and far larger than the thumbnail and cook view need. The browser shrinks them before the
// upload, with a canvas and no library; the server keeps its limit and never resizes (no image processing in the image).
export const MAX_IMAGE_EDGE = 1600;
const JPEG_QUALITY = 0.85;
// Small enough files in a format every browser shows go up unchanged (keeps PNG transparency and saves a re-encode).
const KEEP_BYTES = 1_000_000;
const KEEP_TYPES = ["image/jpeg", "image/png", "image/webp"];

export async function shrinkImage(file: File): Promise<Blob> {
  // createImageBitmap applies the EXIF orientation, so portrait photos stay upright.
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("Das Bild konnte nicht gelesen werden.");
  });
  try {
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= KEEP_BYTES && KEEP_TYPES.includes(file.type)) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/jpeg", JPEG_QUALITY));
    if (!blob) throw new Error("Das Bild konnte nicht verkleinert werden.");
    return blob;
  } finally {
    bitmap.close();
  }
}

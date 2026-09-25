import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, unlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

export type ImageType = { ext: "jpg" | "png" | "webp" | "gif" | "avif"; mime: string };

// File names are content hashes, so they are safe to use in URLs and paths and identical images are stored once.
export const IMAGE_NAME = /^[a-f0-9]{16}\.(jpg|png|webp|gif|avif)$/;

const MIME: Record<ImageType["ext"], string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
};

// The type comes from the file's own bytes, never from the server's Content-Type. SVG is deliberately not accepted.
export function detectImageType(b: Buffer): ImageType | null {
  const ext = ((): ImageType["ext"] | null => {
    if (b.length < 12) return null;
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
    if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
    if (b.toString("latin1", 0, 4) === "GIF8") return "gif";
    if (b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "webp";
    const brand = b.toString("latin1", 4, 12);
    if (brand === "ftypavif" || brand === "ftypavis") return "avif";
    return null;
  })();
  return ext ? { ext, mime: MIME[ext] } : null;
}

export class ImageStore {
  constructor(readonly dir: string) {}

  async save(data: Buffer): Promise<string> {
    const type = detectImageType(data);
    if (!type) throw new Error("not a supported image");
    const name = `${createHash("sha256").update(data).digest("hex").slice(0, 16)}.${type.ext}`;
    await mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, name);
    try {
      await writeFile(file, data, { flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const now = new Date();
      await utimes(file, now, now); // keeps a re-fetched image from being swept while it is pending
    }
    return name;
  }

  async read(name: string): Promise<{ data: Buffer; mime: string } | null> {
    if (!IMAGE_NAME.test(name)) return null;
    try {
      const data = await readFile(path.join(this.dir, name));
      const type = detectImageType(data);
      return type ? { data, mime: type.mime } : null;
    } catch {
      return null;
    }
  }

  async exists(name: string): Promise<boolean> {
    if (!IMAGE_NAME.test(name)) return false;
    try {
      await stat(path.join(this.dir, name));
      return true;
    } catch {
      return false;
    }
  }

  // Deletes images no dish points to. `minAgeMs` protects images that were just fetched by a preview
  // and are waiting for the user to save the dish.
  async sweep(referenced: Iterable<string>, minAgeMs = 60 * 60 * 1000): Promise<number> {
    const keep = new Set(referenced);
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      if (!IMAGE_NAME.test(name) || keep.has(name)) continue;
      const file = path.join(this.dir, name);
      try {
        if (Date.now() - (await stat(file)).mtimeMs < minAgeMs) continue;
        await unlink(file);
        removed++;
      } catch {
        // already gone
      }
    }
    return removed;
  }
}

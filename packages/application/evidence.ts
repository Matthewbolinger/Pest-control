export const MAXIMUM_EVIDENCE_BYTES = 10 * 1024 * 1024;

export type SupportedEvidenceType =
  | "image/jpeg"
  | "image/png"
  | "image/webp";

export function detectEvidenceContentType(
  bytes: ArrayBuffer | Uint8Array,
): SupportedEvidenceType | null {
  const view =
    bytes instanceof Uint8Array
      ? bytes
      : new Uint8Array(bytes);

  if (
    view.length >= 3 &&
    view[0] === 0xff &&
    view[1] === 0xd8 &&
    view[2] === 0xff
  ) {
    return "image/jpeg";
  }

  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (
    view.length >= png.length &&
    png.every((byte, index) => view[index] === byte)
  ) {
    return "image/png";
  }

  if (
    view.length >= 12 &&
    ascii(view, 0, 4) === "RIFF" &&
    ascii(view, 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }

  return null;
}

export function evidenceExtension(type: SupportedEvidenceType) {
  if (type === "image/jpeg") return "jpg";
  if (type === "image/png") return "png";
  return "webp";
}

function ascii(bytes: Uint8Array, from: number, to: number) {
  return String.fromCharCode(...bytes.slice(from, to));
}

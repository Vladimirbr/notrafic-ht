import { IMAGE_HEIGHT, IMAGE_WIDTH } from "./geometry";

const PICTURE_URL = `https://picsum.photos/${String(IMAGE_WIDTH)}/${String(IMAGE_HEIGHT)}`;
const IMAGE_TIMEOUT_MS = 15_000;

export async function decodePicture(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (
      image.naturalWidth !== IMAGE_WIDTH ||
      image.naturalHeight !== IMAGE_HEIGHT
    ) {
      throw new Error("The image does not have the required dimensions.");
    }
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function fetchPicture(fetchImage: typeof fetch) {
  const response = await fetchImage(PICTURE_URL, {
    signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("The image request failed.");
  const blob = await response.blob();
  return { blob, image: await decodePicture(blob) };
}

import sharp from "sharp";
import { pool } from "../db";
import { buildEncryptedPayload, maybeDecryptPayload } from "../utils/dataEncryption";

export type ImageMetadataResponse = {
  imageName: string;
  size: string;
  resolution: string;
  color: boolean;
};

export type ImageMasterRow = {
  id: string;
  name: string;
  size: string;
  resolution: string;
  color: boolean;
  mime_type: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_on: string;
  updated_on: string;
};

function formatSize(bytes: number): string {
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(2)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

export async function extractImageMetadata(
  file: Express.Multer.File
): Promise<ImageMetadataResponse> {
  const metadata = await sharp(file.buffer).metadata();
  const stats = await sharp(file.buffer).stats();

  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  const resolution = width > 0 && height > 0 ? `${width} x ${height}` : "Unknown";

  const channels = stats.channels ?? [];
  const hasRgbChannels = channels.length >= 3;
  let isColor = false;
  if (hasRgbChannels) {
    const channelMeans = channels.slice(0, 3).map((channel) => channel.mean);
    const rgbSpread = Math.max(...channelMeans) - Math.min(...channelMeans);
    isColor = rgbSpread > 1;
  }

  return {
    imageName: file.originalname,
    size: formatSize(file.size),
    resolution,
    color: isColor,
  };
}

export async function saveImageMetadataToDb(args: {
  file: Express.Multer.File;
  meta: ImageMetadataResponse;
  createdBy?: string | null;
  updatedBy?: string | null;
}): Promise<ImageMasterRow> {
  const { file, meta, createdBy = null, updatedBy = null } = args;

  const encryptedPayload = buildEncryptedPayload({
    name: meta.imageName,
    size: meta.size,
    resolution: meta.resolution,
    color: meta.color,
    mime_type: file.mimetype,
    image_data: file.buffer,
    created_by: createdBy,
    updated_by: updatedBy,
  });

  const result = await pool.query(
    `
    INSERT INTO image_master (
      name,
      size,
      resolution,
      color,
      mime_type,
      image_data,
      created_by,
      updated_by,
      created_on,
      updated_on,
      encrypted_payload
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW(), $9)
    RETURNING
      id::text,
      name,
      size,
      resolution,
      color,
      mime_type,
      created_by,
      updated_by,
      created_on::text,
      updated_on::text
    `,
    [
      meta.imageName,
      meta.size,
      meta.resolution,
      meta.color,
      file.mimetype,
      file.buffer,
      createdBy,
      updatedBy,
      encryptedPayload,
    ]
  );

  return result.rows[0] as ImageMasterRow;
}

export async function getAllImagesFromDb(): Promise<ImageMasterRow[]> {
  const result = await pool.query(
    `
    SELECT
      id::text,
      name,
      size,
      resolution,
      color,
      mime_type,
      encrypted_payload,
      created_by,
      updated_by,
      created_on::text,
      updated_on::text
    FROM image_master
    ORDER BY updated_on DESC
    `
  );

  return result.rows.map((r) => {
    if (r.encrypted_payload) {
      try {
        const decrypted = maybeDecryptPayload(r.encrypted_payload) as any;
        return {
          id: r.id,
          name: decrypted?.name ?? r.name,
          size: decrypted?.size ?? r.size,
          resolution: decrypted?.resolution ?? r.resolution,
          color: decrypted?.color ?? r.color,
          mime_type: decrypted?.mime_type ?? r.mime_type,
          created_by: r.created_by,
          updated_by: r.updated_by,
          created_on: r.created_on,
          updated_on: r.updated_on,
        };
      } catch (err) {
        console.warn("Failed to decrypt image metadata:", err);
      }
    }

    return {
      id: r.id,
      name: r.name,
      size: r.size,
      resolution: r.resolution,
      color: r.color,
      mime_type: r.mime_type,
      created_by: r.created_by,
      updated_by: r.updated_by,
      created_on: r.created_on,
      updated_on: r.updated_on,
    };
  }) as ImageMasterRow[];
}

export async function getImageBlobById(
  id: string
): Promise<{ mimeType: string; imageData: Buffer } | null> {
  const result = await pool.query(
    `
    SELECT mime_type, image_data, encrypted_payload
    FROM image_master
    WHERE id = $1
    `,
    [id]
  );

  if (!result.rows[0]) return null;

  let mimeType = result.rows[0].mime_type ?? "image/png";
  let imageData = result.rows[0].image_data;

  if (result.rows[0].encrypted_payload) {
    try {
      const decrypted = maybeDecryptPayload(result.rows[0].encrypted_payload) as any;
      if (decrypted) {
        mimeType = decrypted.mime_type ?? mimeType;
        imageData = decrypted.image_data ?? imageData;
      }
    } catch (err) {
      console.warn("Failed to decrypt image blob payload:", err);
    }
  }

  return {
    mimeType,
    imageData,
  };
}

export async function deleteImageById(id: string): Promise<boolean> {
  const result = await pool.query(`DELETE FROM image_master WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

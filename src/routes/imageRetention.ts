import { Router } from "express";
import multer from "multer";
import { requireUser, type AuthedRequest } from "../middleware/auth";
import {
  deleteImageById,
  extractImageMetadata,
  getAllImagesFromDb,
  getImageBlobById,
  saveImageMetadataToDb,
} from "../services/imageRetentionService";

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post("/metadata", requireUser, upload.array("images"), async (req: AuthedRequest, res) => {
  const files = req.files as Express.Multer.File[] | undefined;

  if (!files || files.length === 0) {
    return res.status(400).json({ error: "At least one image file is required" });
  }

  const allowedMimeTypes = new Set(["image/png", "image/jpeg"]);
  const invalidFile = files.find((file) => !allowedMimeTypes.has(file.mimetype));

  if (invalidFile) {
    return res.status(400).json({
      error: `Unsupported file type: ${invalidFile.originalname}. Only PNG and JPEG are allowed.`,
    });
  }

  try {
    const createdBy = req.user?.email ?? null;
    const updatedBy = req.user?.email ?? null;

    const saved = await Promise.all(
      files.map(async (file) => {
        const meta = await extractImageMetadata(file);
        return saveImageMetadataToDb({ file, meta, createdBy, updatedBy });
      })
    );

    return res.json(saved);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to save image metadata" });
  }
});

router.get("/", requireUser, async (_req, res) => {
  try {
    const images = await getAllImagesFromDb();
    return res.json(images);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to fetch images" });
  }
});

router.get("/:id/image", requireUser, async (req, res) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const row = await getImageBlobById(id);
    if (!row) {
      return res.status(404).json({ error: "Image not found" });
    }

    res.setHeader("Content-Type", row.mimeType);
    return res.send(row.imageData);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to load image preview" });
  }
});

router.delete("/:id", requireUser, async (req, res) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const deleted = await deleteImageById(id);
    if (!deleted) {
      return res.status(404).json({ error: "Image not found" });
    }
    return res.status(204).send();
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to delete image" });
  }
});

export default router;

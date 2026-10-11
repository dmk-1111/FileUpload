import { randomUUID } from "node:crypto";
import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";
import { ObjectId } from "mongodb";
import { client, checkConnection } from "./config/dbConnection.js";

const app = express();
const port = Number(process.env.PORT) || 3000;
const recordsPerPage = 5;
const uploadsDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "uploads");
const database = client.db(process.env.MONGODB_DATABASE || "system_uploads");
const records = database.collection("uploads");
const imageContentTypes = {
    ".avif": "image/avif",
    ".bmp": "image/bmp",
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp"
};

await mkdir(uploadsDirectory, { recursive: true });

const upload = multer({
    storage: multer.diskStorage({
        destination: uploadsDirectory,
        filename: (_req, _file, callback) => callback(null, randomUUID())
    }),
    limits: {
        fileSize: 10 * 1024 * 1024,
        files: 10
    }
});

app.set("view engine", "ejs");
app.set("views", path.join(path.dirname(fileURLToPath(import.meta.url)), "views"));

function uploadDetails(files = []) {
    return files.map((file) => ({
        storageName: file.filename,
        originalName: file.originalname,
        size: file.size
    }));
}

async function removeUploadedFiles(files = []) {
    await Promise.all(files.map(async (file) => {
        try {
            await unlink(file.path);
        } catch (error) {
            if (error.code !== "ENOENT") {
                throw error;
            }
        }
    }));
}

async function removeRecordFiles(files = []) {
    await Promise.all(files.map(async (file) => {
        try {
            await unlink(path.join(uploadsDirectory, file.storageName));
        } catch (error) {
            if (error.code !== "ENOENT") {
                throw error;
            }
        }
    }));
}

function requestedPage(value) {
    if (typeof value !== "string" || !/^\d+$/.test(value)) {
        return 1;
    }

    const page = Number(value);
    return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

async function renderIndex(res, options = {}) {
    const totalRecords = await records.countDocuments();
    const totalPages = Math.max(1, Math.ceil(totalRecords / recordsPerPage));
    const currentPage = Math.min(options.page || 1, totalPages);
    const rows = await records.find()
        .sort({ createdAt: -1 })
        .skip((currentPage - 1) * recordsPerPage)
        .limit(recordsPerPage)
        .toArray();

    res.render("index", {
        records: rows,
        currentPage,
        recordsPerPage,
        totalPages,
        totalRecords,
        pageNumbers: Array.from({ length: totalPages }, (_value, index) => index + 1),
        editingRecord: null,
        nameValue: "",
        error: null,
        ...options
    });
}

app.get("/", async (req, res, next) => {
    try {
        await renderIndex(res, {
            page: requestedPage(req.query.page)
        });
    } catch (error) {
        next(error);
    }
});

app.post("/records", upload.array("files", 10), async (req, res, next) => {
    const name = typeof req.body.name === "string" ? req.body.name.trim() : "";

    if (!name) {
        await removeUploadedFiles(req.files);
        return renderIndex(res.status(400), {
            page: requestedPage(req.query.page || req.body.page),
            nameValue: name,
            error: "Please enter a name."
        });
    }

    try {
        await records.insertOne({
            name,
            files: uploadDetails(req.files),
            createdAt: new Date(),
            updatedAt: new Date()
        });
        return res.redirect("/");
    } catch (error) {
        await removeUploadedFiles(req.files);
        return next(error);
    }
});

app.get("/records/:id/edit", async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) {
        return res.sendStatus(404);
    }

    const record = await records.findOne({ _id: new ObjectId(req.params.id) });
    if (!record) {
        return res.sendStatus(404);
    }

    return renderIndex(res, {
        page: requestedPage(req.query.page),
        editingRecord: record,
        nameValue: record.name,
        error: null
    });
});

app.post("/records/:id/edit", upload.array("files", 10), async (req, res, next) => {
    if (!ObjectId.isValid(req.params.id)) {
        await removeUploadedFiles(req.files);
        return res.sendStatus(404);
    }

    const id = new ObjectId(req.params.id);
    const currentRecord = await records.findOne({ _id: id });
    if (!currentRecord) {
        await removeUploadedFiles(req.files);
        return res.sendStatus(404);
    }

    const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
    if (!name) {
        await removeUploadedFiles(req.files);
        return renderIndex(res.status(400), {
            page: requestedPage(req.query.page),
            editingRecord: currentRecord,
            nameValue: name,
            error: "Please enter a name."
        });
    }

    try {
        await records.updateOne(
            { _id: id },
            {
                $set: { name, updatedAt: new Date() },
                $push: { files: { $each: uploadDetails(req.files) } }
            }
        );
        return res.redirect(`/?page=${requestedPage(req.query.page)}`);
    } catch (error) {
        await removeUploadedFiles(req.files);
        return next(error);
    }
});

app.post("/records/:id/delete", async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) {
        return res.sendStatus(404);
    }

    const record = await records.findOneAndDelete({ _id: new ObjectId(req.params.id) });
    if (!record) {
        return res.sendStatus(404);
    }

    await removeRecordFiles(record.files);
    return res.redirect(`/?page=${requestedPage(req.body.page)}`);
});

app.get("/records/:id/images/:storageName", async (req, res, next) => {
    if (!ObjectId.isValid(req.params.id) || !/^[0-9a-f-]{36}$/i.test(req.params.storageName)) {
        return res.sendStatus(404);
    }

    const record = await records.findOne({
        _id: new ObjectId(req.params.id),
        "files.storageName": req.params.storageName
    });
    const file = record?.files.find((item) => item.storageName === req.params.storageName);
    const contentType = file && imageContentTypes[path.extname(file.originalName).toLowerCase()];
    if (!file || !contentType) {
        return res.sendStatus(404);
    }

    return res.sendFile(path.join(uploadsDirectory, file.storageName), {
        headers: {
            "Content-Disposition": "inline",
            "Content-Type": contentType,
            "X-Content-Type-Options": "nosniff"
        }
    }, (error) => {
        if (error && !res.headersSent) {
            next(error);
        }
    });
});

app.get("/records/:id/files/:storageName", async (req, res, next) => {
    if (!ObjectId.isValid(req.params.id) || !/^[0-9a-f-]{36}$/i.test(req.params.storageName)) {
        return res.sendStatus(404);
    }

    const record = await records.findOne({
        _id: new ObjectId(req.params.id),
        "files.storageName": req.params.storageName
    });
    const file = record?.files.find((item) => item.storageName === req.params.storageName);
    if (!file) {
        return res.sendStatus(404);
    }

    return res.download(
        path.join(uploadsDirectory, file.storageName),
        file.originalName,
        (error) => {
            if (error && !res.headersSent) {
                next(error);
            }
        }
    );
});

app.use(async (error, req, res, _next) => {
    if (error instanceof multer.MulterError) {
        const message = error.code === "LIMIT_FILE_SIZE"
            ? "Each file must be 10 MB or smaller."
            : "You can upload up to 10 files at a time.";
        return renderIndex(res.status(400), { error: message });
    }

    console.error("Request failed:", error);
    if (res.headersSent) {
        return;
    }
    return renderIndex(res.status(500), {
        error: "Something went wrong. Please try again."
    });
});

await checkConnection();

export default app;

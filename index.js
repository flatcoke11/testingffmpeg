const express = require('express');
const cors = require('cors');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const { Storage } = require('@google-cloud/storage');
const axios = require('axios');
const path = require('path');
const fs = require('fs'); // Use the standard 'fs' module for all file operations
const os = require('os'); // To get the system's temporary directory

const app = express();
const PORT = process.env.PORT || 3000;

// --- SETUP ---
app.use(cors());
app.use(express.json());

// Configure Multer for temporary file uploads to the OS temp directory
const upload = multer({ dest: os.tmpdir() });

// Configure Google Cloud Storage
const storage = new Storage();
// ** VITAL STEP: Make sure this is your actual Google Cloud Storage bucket name **
const bucketName = 'ben-ffmpeg-video-bucket-12345'; 

const ensureDirExists = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};


// =================================================================
// === ROUTE 1: AUDIO EXTRACTION API                           ===
// =================================================================
app.post('/extract-audio', upload.single('video'), async (req, res) => {
    if (!req.file) {
        return res.status(400).send('No file uploaded.');
    }

    const tempUploadPath = req.file.path;
    const outputFilename = `${Date.now()}-audio.m4a`;
    const tempAudioOutputPath = path.join(os.tmpdir(), outputFilename);

    console.log(`[Audio] File uploaded to temp path: ${tempUploadPath}`);

    try {
        await new Promise((resolve, reject) => {
            ffmpeg(tempUploadPath)
                .noVideo().audioCodec('aac').save(tempAudioOutputPath)
                .on('error', (err) => reject(new Error(`FFmpeg error: ${err.message}`)))
                .on('end', resolve);
        });
        
        console.log('[Audio] Extraction finished.');
        fs.unlinkSync(tempUploadPath);

        const gcsDestination = `audio/${outputFilename}`;
        console.log(`[Audio] Uploading ${outputFilename} to GCS bucket '${bucketName}'...`);
        
        await storage.bucket(bucketName).upload(tempAudioOutputPath, {
            destination: gcsDestination,
            public: true
        });
        
        console.log('[Audio] Upload to GCS successful.');
        const publicUrl = `https://storage.googleapis.com/${bucketName}/${gcsDestination}`;
        res.status(200).json({ success: true, audioUrl: publicUrl });

    } catch (err) {
        console.error('[Audio] Process failed:', err.message);
        res.status(500).send('Failed to process and upload audio file.');
    } finally {
        if (fs.existsSync(tempAudioOutputPath)) fs.unlinkSync(tempAudioOutputPath);
    }
});


// =================================================================
// === ROUTE 2: KEYFRAME EXTRACTION API                          ===
// =================================================================
app.post('/extract-keyframes', async (req, res) => {
    console.log('[Keyframes] Received a request to extract keyframes.');
    const { videoUrl, shots } = req.body;

    if (!videoUrl || !shots || !Array.isArray(shots)) {
        return res.status(400).json({ error: 'Request body must include "videoUrl" and a "shots" array.' });
    }

    const tempDir = path.join(os.tmpdir(), `keyframes_${Date.now()}`);
    ensureDirExists(tempDir);
    const localVideoPath = path.join(tempDir, 'source.mp4');

    try {
        console.log(`[Keyframes] Downloading video from: ${videoUrl}`);
        const response = await axios({ method: 'get', url: videoUrl, responseType: 'stream' });
        const writer = fs.createWriteStream(localVideoPath);
        response.data.pipe(writer);
        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
        console.log('[Keyframes] Video downloaded successfully.');

        const extractionPromises = [];
        const generatedFiles = [];

        shots.forEach((shot, index) => {
            // Logic for the start frame
            const startFrameFile = `shot_${index}_start.jpg`;
            generatedFiles.push(startFrameFile);
            extractionPromises.push(new Promise((resolve, reject) => {
                ffmpeg(localVideoPath).seekInput(shot.startTime).frames(1).output(path.join(tempDir, startFrameFile))
                    .on('end', resolve).on('error', reject).run();
            }));

            // Logic for the end frame
            const endFrameFile = `shot_${index}_end.jpg`;
            generatedFiles.push(endFrameFile);
            extractionPromises.push(new Promise((resolve, reject) => {
                ffmpeg(localVideoPath).seekInput(shot.endTime).frames(1).output(path.join(tempDir, endFrameFile))
                    .on('end', resolve).on('error', reject).run();
            }));
        });
        
        await Promise.all(extractionPromises);
        console.log(`[Keyframes] All shot boundary frames extracted.`);

        console.log(`[Keyframes] Uploading ${generatedFiles.length} files to GCS...`);
        const uploadPromises = generatedFiles.map(filename => {
            const localFilePath = path.join(tempDir, filename);
            const gcsDestination = `keyframes/${Date.now()}_${filename}`;
            return storage.bucket(bucketName).upload(localFilePath, { destination: gcsDestination, public: true });
        });
        const uploadResults = await Promise.all(uploadPromises);

        const keyframeUrls = uploadResults.map(result => result[0].publicUrl());
        res.status(200).json({ success: true, keyframeUrls: keyframeUrls });

    } catch (error) {
        console.error('[Keyframes] A critical error occurred:', error.message);
        res.status(500).json({ error: 'Failed to process keyframes.' });
    } finally {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
            console.log('[Keyframes] Temporary files cleaned up.');
        }
    }
});

// --- START THE SERVER ---
app.listen(PORT, () => {
    console.log(`FFmpeg Media Service is running on port ${PORT}`);
});
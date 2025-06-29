const express = require('express');
const cors = require('cors');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const { Storage } = require('@google-cloud/storage');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

// --- SETUP ---
app.use(cors());
app.use(express.json());

const upload = multer({ dest: os.tmpdir() });
const storage = new Storage();
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
    // ... (This endpoint remains the same as before)
    if (!req.file) { return res.status(400).send('No file uploaded.'); }
    const tempUploadPath = req.file.path;
    const outputFilename = `${Date.now()}-audio.m4a`;
    const tempAudioOutputPath = path.join(os.tmpdir(), outputFilename);
    try {
        await new Promise((resolve, reject) => {
            ffmpeg(tempUploadPath).noVideo().audioCodec('aac').save(tempAudioOutputPath)
                .on('error', (err) => reject(new Error(`FFmpeg error: ${err.message}`)))
                .on('end', resolve);
        });
        fs.unlinkSync(tempUploadPath);
        const gcsDestination = `audio/${outputFilename}`;
        await storage.bucket(bucketName).upload(tempAudioOutputPath, { destination: gcsDestination });
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
// === ROUTE 2: KEYFRAME EXTRACTION API (COMPLETE VERSION)       ===
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
        await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
        console.log('[Keyframes] Video downloaded successfully.');

        const extractionPromises = [];
        
        // --- LOGIC A: Extract First and Last Frame of Every Shot ---
        console.log('[Keyframes] Preparing to extract shot boundary frames...');
        shots.forEach((shot, index) => {
            // Promise for the start frame
            extractionPromises.push(new Promise((resolve, reject) => {
                ffmpeg(localVideoPath).seekInput(shot.startTime).frames(1).output(path.join(tempDir, `shot_${index}_start.jpg`))
                    .on('end', resolve).on('error', reject).run();
            }));

            // Promise for the end frame
            extractionPromises.push(new Promise((resolve, reject) => {
                ffmpeg(localVideoPath).seekInput(shot.endTime).frames(1).output(path.join(tempDir, `shot_${index}_end.jpg`))
                    .on('end', resolve).on('error', reject).run();
            }));
        });
        
        // --- LOGIC B: Extract a Frame Every 2 Seconds ---
        console.log('[Keyframes] Preparing to extract interval frames...');
        extractionPromises.push(new Promise((resolve, reject) => {
            ffmpeg(localVideoPath)
                .outputOptions('-vf', 'fps=1/2') // Set frame rate to 1 frame per 2 seconds
                .output(path.join(tempDir, 'interval_%04d.jpg'))
                .on('end', resolve)
                .on('error', reject)
                .run();
        }));

        await Promise.all(extractionPromises);
        console.log('[Keyframes] All extraction tasks complete.');

        const generatedFiles = fs.readdirSync(tempDir).filter(f => f.endsWith('.jpg'));
        console.log(`[Keyframes] Found ${generatedFiles.length} keyframes to upload.`);

        // Upload all generated keyframes to GCS
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
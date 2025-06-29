const express = require('express');
const cors = require('cors');
const multer =require('multer');
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
// === ROUTE 2: KEYFRAME EXTRACTION API (with new naming)      ===
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

        // Task A: Extract shot boundary frames sequentially
        console.log('[Keyframes] Starting sequential extraction of shot boundary frames...');
        for (let i = 0; i < shots.length; i++) {
            const shot = shots[i];
            const shotNumber = i + 1;
            console.log(`Processing shot ${shotNumber} of ${shots.length}...`);

            // --- NEW NAMING LOGIC ---
            const startTimeFormatted = shot.startTime.toFixed(2).replace('.', '-');
            const endTimeFormatted = shot.endTime.toFixed(2).replace('.', '-');
            const startFrameFile = `shot_${shotNumber}_start_${startTimeFormatted}s.jpg`;
            const endFrameFile = `shot_${shotNumber}_end_${endTimeFormatted}s.jpg`;
            // --- END NEW NAMING LOGIC ---
            
            await new Promise((resolve, reject) => {
                ffmpeg(localVideoPath).seekInput(shot.startTime).frames(1).output(path.join(tempDir, startFrameFile))
                    .on('end', resolve).on('error', reject).run();
            });
            await new Promise((resolve, reject) => {
                ffmpeg(localVideoPath).seekInput(shot.endTime).frames(1).output(path.join(tempDir, endFrameFile))
                    .on('end', resolve).on('error', reject).run();
            });
        }
        console.log('[Keyframes] Shot boundary frame extraction complete.');

        // Task B: Extract interval frames
        console.log('[Keyframes] Starting extraction of interval frames...');
        await new Promise((resolve, reject) => {
            ffmpeg(localVideoPath)
                .outputOptions('-vf', 'fps=1/2')
                .output(path.join(tempDir, 'interval_frame_%04d.jpg'))
                .on('end', resolve)
                .on('error', reject)
                .run();
        });
        console.log('[Keyframes] Interval frame extraction complete.');

        const generatedFiles = fs.readdirSync(tempDir).filter(f => f.endsWith('.jpg'));
        console.log(`[Keyframes] Found ${generatedFiles.length} keyframes to upload.`);

        const uploadPromises = generatedFiles.map(filename => {
            const localFilePath = path.join(tempDir, filename);
            const gcsDestination = `keyframes/${filename}`; // Use the new descriptive filename
            return storage.bucket(bucketName).upload(localFilePath, { destination: gcsDestination });
        });
        const uploadResults = await Promise.all(uploadPromises);
        
        const keyframeUrls = uploadResults.map(result => `https://storage.googleapis.com/${bucketName}/${result[0].name}`);
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
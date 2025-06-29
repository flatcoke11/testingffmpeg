const express = require('express');
const cors = require('cors');
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

const storage = new Storage();
const bucketName = 'ben-ffmpeg-video-bucket-12345'; 

const ensureDirExists = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};


// =================================================================
// === ROUTE 1: GET MEDIA METADATA (New & Recommended First Step) ===
// =================================================================
app.post('/get-media-metadata', async (req, res) => {
    console.log('[Metadata] Received a request to get media metadata.');
    const { videoUrl } = req.body;
    if (!videoUrl) {
        return res.status(400).json({ error: 'Request body must include "videoUrl".' });
    }

    const tempDir = path.join(os.tmpdir(), `metadata_${Date.now()}`);
    ensureDirExists(tempDir);
    const localVideoPath = path.join(tempDir, 'source.mp4');

    try {
        console.log(`[Metadata] Downloading video from: ${videoUrl}`);
        const response = await axios({ method: 'get', url: videoUrl, responseType: 'stream' });
        const writer = fs.createWriteStream(localVideoPath);
        response.data.pipe(writer);
        await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
        
        const videoDuration = await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(localVideoPath, (err, metadata) => {
                if (err) return reject(new Error(`ffprobe error: ${err.message}`));
                resolve(metadata.format.duration);
            });
        });
        
        console.log(`[Metadata] Detected video duration: ${videoDuration} seconds.`);
        res.status(200).json({ success: true, detectedDuration: videoDuration });

    } catch (error) {
        console.error('[Metadata] A critical error occurred:', error.message);
        res.status(500).json({ error: 'Failed to get media metadata.' });
    } finally {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }
});


// =================================================================
// === ROUTE 2: AUDIO EXTRACTION API (Revised to use URL)      ===
// =================================================================
app.post('/extract-audio', async (req, res) => {
    console.log('[Audio] Received a request to extract audio.');
    const { videoUrl } = req.body;
    if (!videoUrl) {
        return res.status(400).json({ error: 'Request body must include "videoUrl".' });
    }

    const tempDir = path.join(os.tmpdir(), `audio_${Date.now()}`);
    ensureDirExists(tempDir);
    const localVideoPath = path.join(tempDir, 'source.mp4');
    const tempAudioOutputPath = path.join(tempDir, 'audio.m4a');

    try {
        console.log(`[Audio] Downloading video from: ${videoUrl}`);
        const response = await axios({ method: 'get', url: videoUrl, responseType: 'stream' });
        const writer = fs.createWriteStream(localVideoPath);
        response.data.pipe(writer);
        await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
        
        await new Promise((resolve, reject) => {
            ffmpeg(localVideoPath).noVideo().audioCodec('aac').save(tempAudioOutputPath)
                .on('error', (err) => reject(new Error(`FFmpeg error: ${err.message}`)))
                .on('end', resolve);
        });
        
        const gcsDestination = `audio/${Date.now()}-audio.m4a`;
        await storage.bucket(bucketName).upload(tempAudioOutputPath, { destination: gcsDestination });
        
        const publicUrl = `https://storage.googleapis.com/${bucketName}/${gcsDestination}`;
        res.status(200).json({ success: true, audioUrl: publicUrl });

    } catch (err) {
        console.error('[Audio] Process failed:', err.message);
        res.status(500).send('Failed to process and upload audio file.');
    } finally {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }
});


// =================================================================
// === ROUTE 3: KEYFRAME EXTRACTION API                          ===
// =================================================================
app.post('/extract-keyframes', async (req, res) => {
    // This endpoint's logic remains the same, accepting a videoUrl and shots data
    // ... (full code as provided in previous answer) ...
});


// =================================================================
// === ROUTE 4: RECOMBINE AUDIO STEMS API                        ===
// =================================================================
app.post('/recombine-stems', async (req, res) => {
    // This endpoint's logic remains the same
    // ... (full code as provided in previous answer) ...
});


// --- START THE SERVER ---
app.listen(PORT, () => {
    console.log(`FFmpeg Media Service is now a complete toolkit running on port ${PORT}`);
});
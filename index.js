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
app.use(express.json({ limit: '50mb' })); // Allow larger JSON payloads if needed

const upload = multer({ dest: os.tmpdir() });
const storage = new Storage();
const bucketName = 'ben-ffmpeg-video-bucket-12345'; // Make sure this is your correct bucket name

const ensureDirExists = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};


// =================================================================
// === ROUTE 1: AUDIO EXTRACTION API (from file upload)          ===
// =================================================================
app.post('/extract-audio', upload.single('video'), async (req, res) => {
    if (!req.file) {
        return res.status(400).send('No file uploaded.');
    }
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
// === ROUTE 2: KEYFRAME EXTRACTION API (from video URL)       ===
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

        console.log('[Keyframes] Starting sequential extraction of frames...');
        for (let i = 0; i < shots.length; i++) {
            const shot = shots[i];
            const shotNumber = i + 1;
            const startTimeFormatted = shot.startTime.toFixed(2).replace('.', '-');
            const endFrameFile = `shot_${shotNumber}_end_${shot.endTime.toFixed(2).replace('.', '-')}s.jpg`;
            await new Promise((resolve, reject) => {
                ffmpeg(localVideoPath).seekInput(shot.startTime).frames(1).output(path.join(tempDir, `shot_${shotNumber}_start_${startTimeFormatted}s.jpg`))
                    .on('end', resolve).on('error', reject).run();
            });
            await new Promise((resolve, reject) => {
                ffmpeg(localVideoPath).seekInput(shot.endTime).frames(1).output(path.join(tempDir, endFrameFile))
                    .on('end', resolve).on('error', reject).run();
            });
        }
        await new Promise((resolve, reject) => {
            ffmpeg(localVideoPath).outputOptions('-vf', 'fps=1/2').output(path.join(tempDir, 'interval_frame_%04d.jpg'))
                .on('end', resolve).on('error', reject).run();
        });
        console.log('[Keyframes] All extraction tasks complete.');
        
        const generatedFiles = fs.readdirSync(tempDir).filter(f => f.endsWith('.jpg'));
        const uploadPromises = generatedFiles.map(filename => {
            const localFilePath = path.join(tempDir, filename);
            const gcsDestination = `keyframes/${filename}`;
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
        }
    }
});


// =================================================================
// === ROUTE 3: RECOMBINE AUDIO STEMS API (from Demucs URLs)   ===
// =================================================================
app.post('/recombine-stems', async (req, res) => {
    console.log('[Recombine] Received a request to mix audio stems.');
    const { drumsUrl, bassUrl, otherUrl } = req.body;
    if (!drumsUrl || !bassUrl || !otherUrl) {
        return res.status(400).json({ error: 'Request body must include "drumsUrl", "bassUrl", and "otherUrl".' });
    }

    const tempDir = path.join(os.tmpdir(), `recombine_${Date.now()}`);
    ensureDirExists(tempDir);
    const drumsPath = path.join(tempDir, 'drums.wav');
    const bassPath = path.join(tempDir, 'bass.wav');
    const otherPath = path.join(tempDir, 'other.wav');
    const soundscapePath = path.join(tempDir, 'soundscape.wav');

    try {
        console.log('[Recombine] Downloading all audio stems...');
        const downloadPromises = [
            axios({ method: 'get', url: drumsUrl, responseType: 'stream' }).then(response => response.data.pipe(fs.createWriteStream(drumsPath))),
            axios({ method: 'get', url: bassUrl, responseType: 'stream' }).then(response => response.data.pipe(fs.createWriteStream(bassPath))),
            axios({ method: 'get', url: otherUrl, responseType: 'stream' }).then(response => response.data.pipe(fs.createWriteStream(otherPath))),
        ];
        await Promise.all(downloadPromises.map(p => new Promise((resolve, reject) => p.on('finish', resolve).on('error', reject))));
        console.log('[Recombine] All stems downloaded successfully.');

        console.log('[Recombine] Mixing stems into final soundscape.wav...');
        await new Promise((resolve, reject) => {
            ffmpeg().input(drumsPath).input(bassPath).input(otherPath)
                .complexFilter('[0:a][1:a][2:a]amix=inputs=3:duration=first')
                .on('end', resolve)
                .on('error', (err) => reject(new Error(`FFmpeg mixdown error: ${err.message}`)))
                .save(soundscapePath);
        });
        console.log('[Recombine] Mixdown complete.');
        
        const gcsDestination = `soundscapes/${Date.now()}-soundscape.wav`;
        console.log(`[Recombine] Uploading ${gcsDestination} to GCS...`);
        await storage.bucket(bucketName).upload(soundscapePath, { destination: gcsDestination });
        
        console.log('[Recombine] Upload to GCS successful.');
        const publicUrl = `https://storage.googleapis.com/${bucketName}/${gcsDestination}`;
        res.status(200).json({ success: true, soundscapeUrl: publicUrl });
    } catch (error) {
        console.error('[Recombine] A critical error occurred:', error.message);
        res.status(500).json({ error: 'Failed to process audio stems.' });
    } finally {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }
});


// --- START THE SERVER ---
app.listen(PORT, () => {
    console.log(`FFmpeg Media Service is running on port ${PORT}`);
});
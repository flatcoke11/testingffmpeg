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
// === ROUTE 1: GET MEDIA METADATA                           ===
// =================================================================
app.post('/get-media-metadata', async (req, res) => {
    console.log('[Metadata] Received request for full media specs.');
    const { videoUrl } = req.body;
    if (!videoUrl) {
        return res.status(400).json({ error: 'Request body must include "videoUrl".' });
    }

    const tempDir = path.join(os.tmpdir(), `metadata_${Date.now()}`);
    ensureDirExists(tempDir);
    const localVideoPath = path.join(tempDir, 'source.mp4');

    try {
        const response = await axios({ method: 'get', url: videoUrl, responseType: 'stream' });
        const writer = fs.createWriteStream(localVideoPath);
        response.data.pipe(writer);
        await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
        
        const metadata = await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(localVideoPath, (err, data) => {
                if (err) return reject(new Error(`ffprobe error: ${err.message}`));
                resolve(data);
            });
        });
        
        const videoStream = metadata.streams.find(s => s.codec_type === 'video');
        const audioStream = metadata.streams.find(s => s.codec_type === 'audio');
        const result = {
            format: {
                duration: metadata.format.duration,
                size_bytes: metadata.format.size,
                bit_rate: metadata.format.bit_rate,
            },
            video_stream: videoStream ? { codec: videoStream.codec_name, width: videoStream.width, height: videoStream.height, avg_frame_rate: videoStream.avg_frame_rate, nb_frames: videoStream.nb_frames } : null,
            audio_stream: audioStream ? { codec: audioStream.codec_name, sample_rate: audioStream.sample_rate, channels: audioStream.channels, channel_layout: audioStream.channel_layout } : null,
        };
        
        console.log('[Metadata] Successfully extracted full media specs.');
        res.status(200).json({ success: true, metadata: result });

    } catch (error) {
        console.error('[Metadata] Error:', error.message);
        res.status(500).json({ error: 'Failed to get media metadata.' });
    } finally {
        if (fs.existsSync(tempDir)) { fs.rmSync(tempDir, { recursive: true, force: true }); }
    }
});


// =================================================================
// === ROUTE 2: AUDIO EXTRACTION API (URL-based)               ===
// =================================================================
app.post('/extract-audio', async (req, res) => {
    console.log('[Audio] Received request to extract audio.');
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
        const [file] = await storage.bucket(bucketName).upload(tempAudioOutputPath, { destination: gcsDestination });
        
        console.log('[Audio] Upload to GCS successful.');
        res.status(200).json({ success: true, audioUrl: file.publicUrl() });

    } catch (err) {
        console.error('[Audio] Process failed:', err.message);
        res.status(500).send({ error: 'Failed to process and upload audio file.' });
    } finally {
        if (fs.existsSync(tempDir)) { fs.rmSync(tempDir, { recursive: true, force: true }); }
    }
});


// =================================================================
// === ROUTE 3: KEYFRAME EXTRACTION API (UPDATED INTERVAL)     ===
// =================================================================
app.post('/extract-keyframes', async (req, res) => {
    console.log('[Keyframes] Received request.');
    const { videoUrl, shots, total_duration } = req.body; 
    if (!videoUrl || !shots || !Array.isArray(shots) || !total_duration) {
        return res.status(400).json({ error: 'Request body must include "videoUrl", "shots" array, and "total_duration".' });
    }

    const tempDir = path.join(os.tmpdir(), `keyframes_${Date.now()}`);
    ensureDirExists(tempDir);
    const localVideoPath = path.join(tempDir, 'source.mp4');

    // --- NEW: FILENAME FORMATTING HELPER ---
    const formatTimestampForFilename = (timeInSeconds, totalDuration) => {
      const integerPadding = Math.floor(totalDuration).toString().length;
      const parts = timeInSeconds.toFixed(3).split('.');
      const seconds = parts[0].padStart(integerPadding, '0');
      const milliseconds = parts[1];
      return `${seconds}-${milliseconds}`;
    };

    try {
        console.log(`[Keyframes] Downloading video from: ${videoUrl}`);
        const response = await axios({ method: 'get', url: videoUrl, responseType: 'stream' });
        const writer = fs.createWriteStream(localVideoPath);
        response.data.pipe(writer);
        await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
        
        console.log('[Keyframes] Starting sequential frame extraction...');
        
        // --- UPDATED: Task A with new filename logic ---
        for (let i = 0; i < shots.length; i++) {
            const shot = shots[i];
            const shotNumber = i + 1;
            const formattedStartTime = formatTimestampForFilename(shot.startTime, total_duration);
            const formattedEndTime = formatTimestampForFilename(shot.endTime, total_duration);
            const startFrameFile = `${formattedStartTime}_shot-${shotNumber}_start.jpg`;
            const endFrameFile = `${formattedEndTime}_shot-${shotNumber}_end.jpg`;
            
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
        
        // --- UPDATED: Task B with new filename logic ---
        console.log('[Keyframes] Starting precise extraction of interval frames (every 0.5s)...');
        for (let timeInSeconds = 0.5; timeInSeconds < total_duration; timeInSeconds += 0.5) {
            const formattedIntervalTime = formatTimestampForFilename(timeInSeconds, total_duration);
            const intervalFrameFile = `${formattedIntervalTime}_interval.jpg`;
            
            await new Promise((resolve, reject) => {
                ffmpeg(localVideoPath)
                    .seekInput(timeInSeconds)
                    .frames(1)
                    .output(path.join(tempDir, intervalFrameFile))
                    .on('end', resolve)
                    .on('error', reject)
                    .run();
            });
        }
        console.log('[Keyframes] Precise interval frame extraction complete.');

        const generatedFiles = fs.readdirSync(tempDir).filter(f => f.endsWith('.jpg'));
        console.log(`[Keyframes] Found ${generatedFiles.length} frames to upload.`);
        
        const uploadPromises = generatedFiles.map(filename => {
            const localFilePath = path.join(tempDir, filename);
            const gcsDestination = `keyframes/${filename}`;
            return storage.bucket(bucketName).upload(localFilePath, { destination: gcsDestination });
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
        }
    }
});


// =================================================================
// === ROUTE 4: RECOMBINE AUDIO STEMS API                        ===
// =================================================================
app.post('/recombine-stems', async (req, res) => {
    console.log('[Recombine] Received request.');
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
    
    const downloadFile = async (url, outputPath) => {
        const writer = fs.createWriteStream(outputPath);
        const response = await axios({ method: 'get', url, responseType: 'stream' });
        response.data.pipe(writer);
        return new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
    };

    try {
        console.log('[Recombine] Downloading stems...');
        await Promise.all([
            downloadFile(drumsUrl, drumsPath),
            downloadFile(bassUrl, bassPath),
            downloadFile(otherUrl, otherPath)
        ]);
        
        console.log('[Recombine] Mixing stems...');
        await new Promise((resolve, reject) => {
            ffmpeg().input(drumsPath).input(bassPath).input(otherPath)
                .complexFilter('[0:a][1:a][2:a]amix=inputs=3:duration=first')
                .on('end', resolve)
                .on('error', (err) => reject(new Error(`FFmpeg mixdown error: ${err.message}`)))
                .save(soundscapePath);
        });
        
        const gcsDestination = `soundscapes/${Date.now()}-soundscape.wav`;
        const [file] = await storage.bucket(bucketName).upload(soundscapePath, { destination: gcsDestination });
        
        console.log('[Recombine] Upload to GCS successful.');
        res.status(200).json({ success: true, soundscapeUrl: file.publicUrl() });
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
    console.log(`FFmpeg Media Service Toolkit is running on port ${PORT}`);
});
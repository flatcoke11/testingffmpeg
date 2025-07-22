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
// ⚠️ IMPORTANT: Replace this with your actual Google Cloud Storage bucket name
const bucketName = 'your-gcs-bucket-name'; 

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
            ffmpeg().input(drumsPath).input(bassPath).input(otherUrl)
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

// =================================================================
// === ROUTE 5: EXTRACT FACE THUMBNAILS API                    ===
// =================================================================
app.post('/extract-face-thumbnails', async (req, res) => {
    console.log('[Faces] Received request to extract face thumbnails.');
    const { videoUrl, faceAnnotations } = req.body;

    if (!videoUrl || !faceAnnotations || !Array.isArray(faceAnnotations)) {
        return res.status(400).json({ error: 'Request body must include "videoUrl" and a "faceAnnotations" array.' });
    }

    const tempDir = path.join(os.tmpdir(), `faces_${Date.now()}`);
    ensureDirExists(tempDir);
    const localVideoPath = path.join(tempDir, 'source.mp4');

    try {
        console.log(`[Faces] Downloading video from: ${videoUrl}`);
        const response = await axios({ method: 'get', url: videoUrl, responseType: 'stream' });
        const writer = fs.createWriteStream(localVideoPath);
        response.data.pipe(writer);
        await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
        console.log('[Faces] Video downloaded successfully.');

        const metadata = await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(localVideoPath, (err, data) => {
                if (err) return reject(new Error(`ffprobe error: ${err.message}`));
                resolve(data);
            });
        });
        const videoStream = metadata.streams.find(s => s.codec_type === 'video');
        if (!videoStream || !videoStream.width || !videoStream.height) {
            throw new Error("Could not determine video dimensions.");
        }
        const videoWidth = videoStream.width;
        const videoHeight = videoStream.height;
        console.log(`[Faces] Video dimensions: ${videoWidth}x${videoHeight}`);
        
        const generatedFiles = [];

        console.log(`[Faces] Starting extraction for ${faceAnnotations.length} detected face tracks...`);
        for (const face of faceAnnotations) {
            if (!face.timeSegments || face.timeSegments.length === 0) continue;
            const segment = face.timeSegments[0];
            const timestamp = segment.startTime + ((segment.endTime - segment.startTime) / 2);

            const box = face.normalizedBoundingBox;
            const cropWidth = Math.round((box.right - box.left) * videoWidth);
            const cropHeight = Math.round((box.bottom - box.top) * videoHeight);
            const cropX = Math.round(box.left * videoWidth);
            const cropY = Math.round(box.top * videoHeight);

            const outputFilename = `${face.faceId}_at_${timestamp.toFixed(2)}s.jpg`;
            const outputFilePath = path.join(tempDir, outputFilename);
            generatedFiles.push(outputFilename);
            
            await new Promise((resolve, reject) => {
                ffmpeg(localVideoPath)
                    .seekInput(timestamp)
                    .videoFilter(`crop=${cropWidth}:${cropHeight}:${cropX}:${cropY}`)
                    .frames(1)
                    .output(outputFilePath)
                    .on('end', resolve)
                    .on('error', reject)
                    .run();
            });
        }
        console.log('[Faces] All face thumbnails extracted.');

        console.log(`[Faces] Uploading ${generatedFiles.length} files to GCS...`);
        const uploadPromises = generatedFiles.map(filename => {
            const localFilePath = path.join(tempDir, filename);
            const gcsDestination = `face_thumbnails/${filename}`;
            return storage.bucket(bucketName).upload(localFilePath, { destination: gcsDestination });
        });
        const uploadResults = await Promise.all(uploadPromises);
        
        const thumbnailUrlUrls = uploadResults.map(result => result[0].publicUrl());
        
        res.status(200).json({ success: true, faceThumbnailUrls: thumbnailUrlUrls });

    } catch (error) {
        console.error('[Faces] A critical error occurred:', error.message);
        res.status(500).json({ error: 'Failed to process face thumbnails.' });
    } finally {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }
});


// =================================================================
// === ROUTE 6: SPLIT VIDEO BY SCENE API                         ===
// =================================================================
app.post('/split-by-scene', async (req, res) => {
    console.log('[Scene Split] Received request to split video by scenes.');
    const { videoUrl, sceneAnnotations } = req.body;

    if (!videoUrl || !sceneAnnotations || !Array.isArray(sceneAnnotations)) {
        return res.status(400).json({ error: 'Request body must include "videoUrl" and a "sceneAnnotations" array.' });
    }

    const tempDir = path.join(os.tmpdir(), `scenes_${Date.now()}`);
    ensureDirExists(tempDir);
    const localVideoPath = path.join(tempDir, 'source.mp4');

    try {
        console.log(`[Scene Split] Downloading video from: ${videoUrl}`);
        const response = await axios({ method: 'get', url: videoUrl, responseType: 'stream' });
        const writer = fs.createWriteStream(localVideoPath);
        response.data.pipe(writer);
        await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
        console.log('[Scene Split] Video downloaded successfully.');

        const generatedFiles = [];

        console.log(`[Scene Split] Starting scene splitting for ${sceneAnnotations.length} scenes...`);
        for (let i = 0; i < sceneAnnotations.length; i++) {
            const scene = sceneAnnotations[i];
            const startTime = scene.startTime.endsWith('s') ? scene.startTime.slice(0, -1) : scene.startTime;
            const endTime = scene.endTime.endsWith('s') ? scene.endTime.slice(0, -1) : scene.endTime;
            const duration = parseFloat(endTime) - parseFloat(startTime);

            if (isNaN(duration) || duration <= 0) {
                console.warn(`[Scene Split] Skipping invalid scene segment: ${JSON.stringify(scene)}`);
                continue;
            }

            const outputFilename = `scene_${i + 1}_${startTime}s_to_${endTime}s.mp4`;
            const outputFilePath = path.join(tempDir, outputFilename);
            
            await new Promise((resolve, reject) => {
                ffmpeg(localVideoPath)
                    .setStartTime(startTime)
                    .setDuration(duration)
                    .outputOptions('-c', 'copy') // Use stream copy to avoid re-encoding for speed
                    .output(outputFilePath)
                    .on('end', () => {
                        generatedFiles.push(outputFilename);
                        resolve();
                    })
                    .on('error', (err) => {
                        console.error(`[Scene Split] FFmpeg error for scene ${i+1}: ${err.message}`);
                        reject(err);
                    })
                    .run();
            });
        }
        console.log('[Scene Split] All scene clips created.');

        console.log(`[Scene Split] Uploading ${generatedFiles.length} files to GCS...`);
        const uploadPromises = generatedFiles.map(filename => {
            const localFilePath = path.join(tempDir, filename);
            const gcsDestination = `scenes/${filename}`;
            return storage.bucket(bucketName).upload(localFilePath, { destination: gcsDestination });
        });
        const uploadResults = await Promise.all(uploadPromises);

        const sceneUrls = uploadResults.map(result => result[0].publicUrl());

        res.status(200).json({ success: true, sceneUrls });

    } catch (error) {
        console.error('[Scene Split] A critical error occurred:', error.message);
        res.status(500).json({ error: 'Failed to process video scenes.' });
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
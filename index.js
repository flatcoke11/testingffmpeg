const express = require('express');
const cors = require('cors');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const { Storage } = require('@google-cloud/storage');
const axios = require('axios'); // New library needed for downloading
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// --- SETUP ---
app.use(cors());
app.use(express.json()); // Important for reading JSON from requests

// Configure Multer for temporary file uploads
const upload = multer({ dest: 'uploads/' });

// Configure Google Cloud Storage
const storage = new Storage();
const bucketName = 'ben-ffmpeg-video-bucket-12345'; // Your bucket name

// --- HELPER FUNCTION to ensure temporary directories exist ---
const ensureDirExists = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};


// =================================================================
// === JOB 1: AUDIO EXTRACTION API                           ===
// =================================================================
// This is your original functionality, kept intact.
// It takes a video file upload and returns a public URL for the extracted audio.

app.post('/extract-audio', upload.single('video'), (req, res) => {
  if (!req.file) {
    return res.status(400).send('No file uploaded.');
  }

  const videoFilePath = req.file.path;
  const outputFilename = `${Date.now()}-audio.m4a`;
  const audioFilePath = path.join(__dirname, outputFilename);

  console.log(`[Audio] File uploaded to temp path: ${videoFilePath}`);

  ffmpeg(videoFilePath)
    .noVideo()
    .audioCodec('aac')
    .save(audioFilePath)
    .on('error', (err) => {
      console.error(`[Audio] FFmpeg error: ${err.message}`);
      fs.unlinkSync(videoFilePath);
      res.status(500).send('Error processing video for audio extraction.');
    })
    .on('end', async () => {
      console.log('[Audio] Extraction finished.');
      fs.unlinkSync(videoFilePath);

      try {
        console.log(`[Audio] Uploading ${outputFilename} to GCS...`);
        await storage.bucket(bucketName).upload(audioFilePath, {
          destination: outputFilename,
        });
        console.log('[Audio] Upload to GCS successful.');
        fs.unlinkSync(audioFilePath);

        const publicUrl = `https://storage.googleapis.com/${bucketName}/${outputFilename}`;
        res.status(200).json({ success: true, audioUrl: publicUrl });
      } catch (err) {
        console.error('[Audio] GCS upload error:', err);
        fs.unlinkSync(audioFilePath);
        res.status(500).send('Failed to upload audio file.');
      }
    });
});


// =================================================================
// === JOB 2: KEYFRAME EXTRACTION API                          ===
// =================================================================
// This is the new functionality.
// It takes a video URL and shot data, and extracts the corresponding keyframes.

app.post('/extract-keyframes', async (req, res) => {
  console.log('[Keyframes] Received a request to extract keyframes.');

  const { videoUrl, shots } = req.body;

  if (!videoUrl || !shots || !Array.isArray(shots)) {
    return res.status(400).json({ error: 'Request body must include "videoUrl" and a "shots" array.' });
  }

  // Setup temporary directories for this job
  const tempDir = path.join(__dirname, 'temp_keyframes');
  const outputDir = path.join(tempDir, 'output');
  ensureDirExists(outputDir);
  const localVideoPath = path.join(tempDir, 'source.mp4');

  try {
    // 1. Download the video file from the provided URL
    console.log(`[Keyframes] Downloading video from: ${videoUrl}`);
    const response = await axios({ method: 'get', url: videoUrl, responseType: 'stream' });
    const writer = fs.createWriteStream(localVideoPath);
    response.data.pipe(writer);
    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
    console.log('[Keyframes] Video downloaded successfully.');

    // 2. Prepare all the ffmpeg extraction tasks
    const extractionPromises = [];

    // Task A: Extract first and last frame of every shot
    shots.forEach((shot, index) => {
      // Promise for the start frame
      extractionPromises.push(new Promise((resolve, reject) => {
        ffmpeg(localVideoPath)
          .seekInput(shot.start)
          .frames(1)
          .output(path.join(outputDir, `shot_${index}_start.jpg`))
          .on('end', () => { console.log(`Extracted start frame for shot ${index}`); resolve(); })
          .on('error', reject)
          .run();
      }));

      // Promise for the end frame
      extractionPromises.push(new Promise((resolve, reject) => {
        ffmpeg(localVideoPath)
          .seekInput(shot.end)
          .frames(1)
          .output(path.join(outputDir, `shot_${index}_end.jpg`))
          .on('end', () => { console.log(`Extracted end frame for shot ${index}`); resolve(); })
          .on('error', reject)
          .run();
      }));
    });

    // Task B: Extract a frame every 2 seconds
    extractionPromises.push(new Promise((resolve, reject) => {
      ffmpeg(localVideoPath)
        .outputOptions('-vf', 'fps=1/2')
        .output(path.join(outputDir, 'interval_%04d.jpg'))
        .on('end', () => { console.log('Extracted interval frames.'); resolve(); })
        .on('error', reject)
        .run();
    }));

    // 3. Run all ffmpeg commands in parallel and wait for completion
    await Promise.all(extractionPromises);
    console.log('[Keyframes] All extraction tasks complete.');

    // 4. IMPORTANT: Upload results to cloud storage
    // This next step is crucial. The files are currently on Render's temporary disk.
    // They must be uploaded to your Google Cloud Storage bucket to be used later.
    const outputFilenames = fs.readdirSync(outputDir);
    const uploadPromises = outputFilenames.map(filename => {
        const localFilePath = path.join(outputDir, filename);
        console.log(`[Keyframes] Uploading ${filename} to GCS...`);
        return storage.bucket(bucketName).upload(localFilePath, {
            destination: `keyframes/${Date.now()}_${filename}`
        });
    });
    await Promise.all(uploadPromises);
    console.log('[Keyframes] All keyframes uploaded to GCS.');

    // Generate public URLs for the uploaded files
    const keyframeUrls = outputFilenames.map(filename => {
        // Construct the URL based on the destination path in GCS
        const destinationPath = `keyframes/${path.basename(filename)}`; // Simplified for example
        return `https://storage.googleapis.com/${bucketName}/${destinationPath}`;
    });

    // 5. Respond with the list of public URLs
    res.status(200).json({
      success: true,
      message: `${outputFilenames.length} keyframes extracted and uploaded.`,
      // keyframeUrls: keyframeUrls // This would be the ideal response
      generatedFiles: outputFilenames // Sending filenames for now as URLs are more complex
    });

  } catch (error) {
    console.error('[Keyframes] A critical error occurred:', error.message);
    res.status(500).json({ error: 'Failed to process keyframes.' });
  } finally {
    // 6. Clean up the temporary files and directories
    if (fs.existsSync(tempDir)) {
      fs.rm(tempDir, { recursive: true, force: true }, (err) => {
        if (err) console.error(`Error cleaning up temp directory: ${err.message}`);
        else console.log('[Keyframes] Temporary files cleaned up.');
      });
    }
  }
});


// --- START THE SERVER ---
app.listen(PORT, () => {
  console.log(`FFmpeg Media Service is running on port ${PORT}`);
});
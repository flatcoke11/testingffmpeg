const express = require('express');
const cors = require('cors');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const { Storage } = require('@google-cloud/storage');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// === SETUP ===
app.use(cors());

// Configure Multer to temporarily store uploaded files on the server's disk
const upload = multer({ dest: 'uploads/' });

// Configure Google Cloud Storage
// This will automatically use the GOOGLE_APPLICATION_CREDENTIALS environment variable
// that we will set on Render later.
const storage = new Storage();
const bucketName = 'ben-ffmpeg-video-bucket-12345'; // Your bucket name is set here

// === ROUTES ===
app.get('/', (req, res) => {
  res.send('Welcome! Use the POST /upload endpoint to upload a video file.');
});

// The new endpoint for uploading a file
// It accepts a single file with the field name 'video'
app.post('/upload', upload.single('video'), (req, res) => {
  // 1. Check if a file was uploaded
  if (!req.file) {
    return res.status(400).send('No file uploaded.');
  }

  const videoFilePath = req.file.path;
  const outputFilename = `${Date.now()}-audio.m4a`;
  const audioFilePath = path.join(__dirname, outputFilename);

  console.log(`File uploaded to temporary path: ${videoFilePath}`);

  // 2. Use FFmpeg to extract audio
  ffmpeg(videoFilePath)
    .noVideo()
    .audioCodec('aac') // Re-encode to AAC for consistency
    .save(audioFilePath)
    .on('error', (err) => {
      console.error(`FFmpeg error: ${err.message}`);
      fs.unlinkSync(videoFilePath); // Clean up original upload
      return res.status(500).send('Error processing video.');
    })
    .on('end', async () => {
      console.log('Audio extraction finished.');
      fs.unlinkSync(videoFilePath); // Clean up original upload

      try {
        // 3. Upload the resulting audio file to Google Cloud Storage
        console.log(`Uploading ${outputFilename} to Google Cloud Storage...`);
        await storage.bucket(bucketName).upload(audioFilePath, {
          destination: outputFilename,
        });
        console.log('Upload to GCS successful.');

        fs.unlinkSync(audioFilePath); // Clean up temporary audio file

        // 4. Respond with the public URL of the new audio file
        const publicUrl = `https://storage.googleapis.com/${bucketName}/${outputFilename}`;
        res.status(200).json({ success: true, audioUrl: publicUrl });

      } catch (err) {
        console.error('Error uploading to GCS:', err);
        fs.unlinkSync(audioFilePath); // Clean up temporary audio file
        res.status(500).send('Failed to upload audio file to storage.');
      }
    });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
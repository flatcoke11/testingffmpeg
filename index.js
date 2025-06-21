const express = require('express');
const cors = require('cors');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Use CORS - This allows other websites to make requests to your API
app.use(cors());

// --- Your existing endpoints ---
app.get('/', (req, res) => {
  res.send('Welcome! Use /extract-audio?url=VIDEO_URL to extract audio.');
});

app.get('/ffmpeg-version', (req, res) => {
  ffmpeg.getAvailableCodecs((err, codecs) => {
    if (err) {
      return res.status(500).send(`Error getting FFmpeg info: ${err.message}`);
    }
    res.json(codecs); // Sending back all available codecs as proof
  });
});

// --- The NEW endpoint for extracting audio ---
app.get('/extract-audio', (req, res) => {
  // 1. Get the video URL from the query parameter
  const videoUrl = req.query.url;

  // 2. VERY IMPORTANT: Basic validation. Is there a URL?
  if (!videoUrl) {
    return res.status(400).send('Error: Please provide a video URL using the ?url= parameter.');
  }
  
  // 3. Define a temporary path to save the output file
  const outputPath = path.join(__dirname, `${Date.now()}-audio.m4a`);

  console.log(`Starting audio extraction for: ${videoUrl}`);
  console.log(`Output will be saved to: ${outputPath}`);

  // 4. Use fluent-ffmpeg to process the video
  ffmpeg(videoUrl)
    .noVideo() // Tell FFmpeg to ignore the video track
    .audioCodec('copy') // Copy the audio stream directly without re-encoding (fast!)
    .save(outputPath) // Save the output to our temporary path
    .on('error', (err) => {
      // Handle errors
      console.error(`FFmpeg error: ${err.message}`);
      return res.status(500).send(`Error processing video: ${err.message}`);
    })
    .on('end', () => {
      // Handle success
      console.log('Extraction finished successfully.');
      
      // 5. Send the file to the user for download
      res.download(outputPath, 'audio.m4a', (err) => {
        if (err) {
          console.error(`Error sending file: ${err.message}`);
        }
        
        // 6. IMPORTANT: Clean up by deleting the temporary file from the server
        fs.unlinkSync(outputPath);
        console.log(`Cleaned up temporary file: ${outputPath}`);
      });
    });
});


app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
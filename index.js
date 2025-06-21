const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process'); // Using execFile for better security
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

app.get('/', (req, res) => {
  res.send('Welcome! Use /extract-audio?url=VIDEO_URL to extract audio.');
});

// The NEW endpoint using yt-dlp
app.get('/extract-audio', (req, res) => {
  const videoUrl = req.query.url;

  if (!videoUrl) {
    return res.status(400).send('Error: Please provide a video URL using the ?url= parameter.');
  }

  // Define a unique filename for the output
  const outputFilename = `${Date.now()}-audio.m4a`;
  const outputPath = path.join(__dirname, outputFilename);

  console.log(`Starting audio extraction for: ${videoUrl}`);
  
  // These are the arguments for the yt-dlp command
  const args = [
    '--extract-audio',
    '--audio-format', 'm4a',
    '-o', outputPath, // Tell yt-dlp where to save the file
    videoUrl // The video URL to process
  ];

  // Execute the yt-dlp command
  execFile('yt-dlp', args, (error, stdout, stderr) => {
    if (error) {
      console.error(`execFile error: ${error.message}`);
      console.error(`stderr: ${stderr}`);
      return res.status(500).send(`Error processing video. Check terminal logs for details.`);
    }

    console.log('Extraction finished successfully.');
    
    // Send the downloaded file
    res.download(outputPath, 'audio.m4a', (err) => {
      if (err) {
        console.error(`Error sending file: ${err.message}`);
      }
      
      // Clean up the temporary file
      fs.unlinkSync(outputPath);
      console.log(`Cleaned up temporary file: ${outputPath}`);
    });
  });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
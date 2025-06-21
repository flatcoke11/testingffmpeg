const express = require('express');
const { exec } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

// A simple endpoint to check if the service is up
app.get('/', (req, res) => {
  res.send('FFmpeg service is running. Use /ffmpeg-version to check.');
});

// Endpoint to verify FFmpeg installation
app.get('/ffmpeg-version', (req, res) => {
  // Execute the ffmpeg -version command
  exec('ffmpeg -version', (error, stdout, stderr) => {
    if (error) {
      console.error(`exec error: ${error}`);
      return res.status(500).send(`FFmpeg not found or error executing command: ${error.message}`);
    }
    // Send the output (which contains version info) back to the client
    res.type('text/plain').send(stdout || stderr);
  });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
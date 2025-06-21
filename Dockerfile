# Start with an official Node.js image.
FROM node:18-slim

# 1. Install FFmpeg, Python, and the Python package manager 'pip'
RUN apt-get update && apt-get install -y ffmpeg python3 python3-pip && rm -rf /var/lib/apt/lists/*

# 2. Use pip to install the latest version of yt-dlp
RUN pip3 install yt-dlp --break-system-packages

# 3. Set up the application environment.
WORKDIR /app

# 4. Copy your application's dependency manifest and install dependencies.
COPY package*.json ./
RUN npm install

# 5. Copy the rest of your application code into the container.
COPY . .

# 6. Expose the port your application will run on.
EXPOSE 3000

# 7. Define the command to start your application.
CMD ["node", "index.js"]
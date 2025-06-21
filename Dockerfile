# 1. Start with an official Node.js image.
# The 'slim' variant is smaller and great for production.
FROM node:18-slim

# 2. Use the built-in package manager (apt) to install FFmpeg.
# This is the magic step.
# `RUN` executes commands inside the container's OS (which is Debian).
RUN apt-get update && apt-get install -y ffmpeg

# 3. Set up the application environment.
WORKDIR /app

# 4. Copy your application's dependency manifest and install dependencies.
# This is done in a separate step to leverage Docker's layer caching.
COPY package*.json ./
RUN npm install

# 5. Copy the rest of your application code into the container.
COPY . .

# 6. Expose the port your application will run on.
EXPOSE 3000

# 7. Define the command to start your application.
CMD ["node", "index.js"]
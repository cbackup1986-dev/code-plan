# Use Node.js 20 slim as base image
FROM node:20-slim

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (only production)
RUN npm install --omit=dev

# Copy source code
COPY src/ ./src/

# Create data directory for persistence
RUN mkdir -p data/ && chmod 777 data/

# Expose server port
EXPOSE 3000

# Set environment variables (optional defaults)
ENV PORT=3000
ENV NODE_ENV=production

# Start the server
# Note: In Docker, we recommend passing env vars via -e or docker-compose
# instead of relying on a physical .env file inside the image.
CMD ["node", "src/server.js"]

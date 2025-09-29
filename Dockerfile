# Use AWS Lambda Node.js 16 base image
FROM public.ecr.aws/lambda/nodejs:16

# Copy Lambda Web Adapter
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.8.4 /lambda-adapter /opt/extensions/lambda-adapter

# Set working directory
WORKDIR ${LAMBDA_TASK_ROOT}

# Copy package files
COPY package*.json ./
COPY yarn.lock ./

# Install production dependencies
RUN npm install --omit=dev

# Copy application code
COPY lib/ ./lib/
COPY api/ ./api/
COPY views/ ./views/
COPY server.js ./server.js

# Override the Lambda entrypoint to run our server
ENTRYPOINT []
CMD ["node", "server.js"]

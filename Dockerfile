# Use AWS Lambda Node.js 24 base image
FROM public.ecr.aws/lambda/nodejs:24

# Copy Lambda Web Adapter
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.8.4 /lambda-adapter /opt/extensions/lambda-adapter

# The default HTTP readiness check calls GET /, which loads releases from
# GitHub. During a GitHub outage that returns 503, so init never completed and
# the adapter retried the GitHub refresh in a loop. Check the port instead.
ENV AWS_LWA_READINESS_CHECK_PROTOCOL=tcp

# Set working directory
WORKDIR ${LAMBDA_TASK_ROOT}

# Copy package files
COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev

# Copy application code
COPY lib/ ./lib/
COPY api/ ./api/
COPY views/ ./views/
COPY server.js ./server.js

# Override the Lambda entrypoint to run our server
ENTRYPOINT []
CMD ["node", "server.js"]

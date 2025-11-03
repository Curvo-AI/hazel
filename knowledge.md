# Hazel - Electron Update Server

## Mission
Lightweight update server for Electron apps. Pulls releases from GitHub, caches them, and serves update checks for macOS and Windows.

## Architecture
- Built on micro framework
- Caches GitHub release data every 15 minutes (configurable via INTERVAL env var)
- Routes updates through GitHub assets directly to save bandwidth
- Supports deployment on Vercel or AWS Lambda

## Key Components
- `lib/cache.js` - Manages GitHub release data caching
- `lib/routes.js` - Handles update checks, downloads, and platform detection
- `lib/server.js` - Main request handler
- `server.js` - AWS deployment entry point with SSM parameter loading

## Private Repository Support
- Use TOKEN env var for GitHub authentication
- Proxies downloads through Hazel instead of direct GitHub links
- Special handling for Windows RELEASES files to proxy .nupkg downloads

## Platform Detection
- Supports darwin, win32, dmg, exe, and ARM variants
- Auto-detects from user agent or explicit platform parameter
- Uses aliases in `lib/aliases.js` for platform name normalization

## Deployment Streams (Multi-Stream Support)
- Support multiple deployment streams via tag-based filtering
- Tag releases with suffixes: `v1.0.0-uat`, `v1.0.0-staging`, etc.
- Production stream: tags without suffix or with `-production`
- Stream name is everything after first hyphen in tag
- Clients specify stream via query param: `?stream=uat`
- Default stream is `production` if not specified
- All streams cached simultaneously from single GitHub API call
- Overview page shows stream selector dropdown

## Development
- Local dev: `yarn dev:local` or `vercel dev`
- AWS dev: `yarn aws:local` (requires env.json)
- Testing: `yarn test` (runs xo linter + jest)

## Deployment
- Vercel: Auto-deploys via vercel.json
- AWS: Use SAM commands (aws:build, aws:deploy, etc.)

## Code Style
- Uses XO linter with Prettier
- No semicolons, single quotes
- Husky pre-commit hooks enforce linting

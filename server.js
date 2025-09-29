const http = require('http')
const { loadSSMParameters } = require('./lib/ssm')

async function startServer() {
  try {
    // Load SSM parameters first
    await loadSSMParameters()

    // Import server handler after SSM parameters are loaded
    const handler = require('./lib/server')

    const PORT = process.env.PORT || 8080

    const server = http.createServer(handler)

    server.listen(PORT, () => {
      console.log(`Hazel server listening on port ${PORT}`)
      console.log(`Account: ${process.env.ACCOUNT}`)
      console.log(`Repository: ${process.env.REPOSITORY}`)
    })
  } catch (error) {
    console.error('Failed to start server:', error)
    process.exit(1)
  }
}

startServer()

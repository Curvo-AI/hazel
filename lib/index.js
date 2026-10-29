// Packages
const Router = require('router')
const finalhandler = require('finalhandler')
const { send } = require('micro')
const Cache = require('./cache')

// Without this, a failed GitHub refresh leaves the request open until timeout
const handle = route => async (req, res) => {
  try {
    await route(req, res)
  } catch (error) {
    console.error(`${req.method} ${req.url} failed:`, error)

    if (!res.headersSent) {
      send(res, 503, {
        error: 'cache_unavailable',
        message: 'Release data could not be loaded from GitHub'
      })
    }
  }
}

module.exports = config => {
  const router = Router()
  let cache = null

  try {
    cache = new Cache(config)
  } catch (err) {
    const { code, message } = err

    if (code) {
      return (req, res) => {
        res.statusCode = 400

        res.end(
          JSON.stringify({
            error: {
              code,
              message
            }
          })
        )
      }
    }

    throw err
  }

  const routes = require('./routes')({ cache, config })

  // Define a route for every relevant path
  router.get('/', handle(routes.overview))
  router.get('/download', handle(routes.download))
  router.get('/download/:platform', handle(routes.downloadPlatform))
  router.get('/download/file/:filename', handle(routes.downloadFile))
  router.get('/update/:platform/:version', handle(routes.update))
  router.get('/update/win32/:version/RELEASES', handle(routes.releases))

  return (req, res) => {
    router(req, res, finalhandler(req, res))
  }
}

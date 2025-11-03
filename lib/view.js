// Native
const path = require('path')
const fs = require('fs')
const { promisify } = require('util')

// Packages
const handlebars = require('handlebars')

// Register Handlebars helper for equality check
handlebars.registerHelper('eq', function(a, b) {
  return a === b
})

module.exports = async () => {
  const viewPath = path.normalize(path.join(__dirname, '/../views/index.hbs'))
  const viewContent = await promisify(fs.readFile)(viewPath, 'utf8')

  return handlebars.compile(viewContent)
}

const webpack = require('webpack')
const WebpackDevServer = require('webpack-dev-server')

const appPaths = require('./app-paths')
const openBrowser = require('./helpers/open-browser')
const { log } = require('./helpers/logger')

let alreadyNotified = false
module.exports = class DevServer {
  constructor (quasarConfFile) {
    this.quasarConfFile = quasarConfFile
  }

  async listen () {
    const cfg = this.quasarConfFile.quasarConf
    const webpackConf = this.quasarConfFile.webpackConf

    log(`Booting up...`)

    return new Promise(resolve => (
      cfg.ctx.mode.ssr
        ? this.listenSSR(webpackConf, cfg, resolve)
        : this.listenCSR(webpackConf, cfg, resolve)
    ))
  }

  listenCSR (webpackConf, cfg, resolve) {
    const compiler = webpack(webpackConf.renderer || webpackConf)

    compiler.hooks.done.tap('done-compiling', compiler => {
      if (this.__started) { return }

      // start dev server if there are no errors
      if (compiler.compilation.errors && compiler.compilation.errors.length > 0) {
        return
      }

      this.__started = true

      server.listen(cfg.devServer.port, cfg.devServer.host, () => {
        resolve()

        if (alreadyNotified) { return }
        alreadyNotified = true

        if (cfg.__devServer.open && ['spa', 'pwa'].includes(cfg.ctx.modeName)) {
          openBrowser({ url: cfg.build.APP_URL, opts: cfg.__devServer.openOptions })
        }
      })
    })

    // start building & launch server
    const server = new WebpackDevServer(compiler, cfg.devServer)

    this.__cleanup = () => {
      this.__cleanup = null
      return new Promise(resolve => {
        server.close(resolve)
      })
    }
  }

  listenSSR (webpackConf, cfg, resolve) {
    const fs = require('fs')
    // TODO vue3 - LRU cache
    // const LRU = require('lru-cache')
    const express = require('express')
    const chokidar = require('chokidar')
    const { renderToString } = require('@vue/server-renderer')
    const createRenderer = require('@quasar/ssr-helpers/create-renderer')
    const ouchInstance = require('./helpers/cli-error-handling').getOuchInstance()
    const SsrExtension = require('./ssr/ssr-extension')

    let renderSSR, renderTemplate, serverManifest, clientManifest, pwa, ready

    const renderOptions = {
      vueRenderToString: renderToString,
      basedir: appPaths.resolve.app('.')
    }

    // read template from disk and watch
    const { getIndexHtml } = require('./ssr/html-template')
    const templatePath = appPaths.resolve.app(cfg.sourceFiles.indexHtmlTemplate)

    function getTemplate () {
      return getIndexHtml(fs.readFileSync(templatePath, 'utf-8'), cfg)
    }

    renderTemplate = getTemplate()
    const htmlWatcher = chokidar.watch(templatePath).on('change', () => {
      renderTemplate = getTemplate()
      console.log('index.template.html template updated.')
    })

    function render (req, res) {
      const startTime = Date.now()

      res.setHeader('Content-Type', 'text/html')

      const handleError = err => {
        if (err.url) {
          res.redirect(err.url)
        }
        else if (err.code === 404) {
          res.status(404).send('404 | Page Not Found')
        }
        else {
          ouchInstance.handleException(err, req, res, () => {
            console.error(`${req.url} -> error during render`)
            console.error(err.stack)
          })
        }
      }

      const ssrContext = {
        url: req.url,
        req,
        res
      }

      renderSSR(ssrContext, renderTemplate)
        .then(html => {
          res.send(html)
          console.log(`${req.url} -> request took: ${Date.now() - startTime}ms`)
        })
        .catch(handleError)

      // TODO vue3
      // if (cfg.__meta) {
      //   html = context.$getMetaHTML(html, context)
      // }
    }

    const readyPromise = new Promise(r => { ready = r })
    function update () {
      if (serverManifest && clientManifest) {
        Object.assign(renderOptions, {
          serverManifest,
          clientManifest
        })

        renderSSR = createRenderer(renderOptions)
        ready()
      }
    }

    const serverCompiler = webpack(webpackConf.server)
    const clientCompiler = webpack(webpackConf.client)

    serverCompiler.hooks.done.tapAsync('done-compiling', ({ compilation: { errors, warnings, assets }}, cb) => {
      errors.forEach(err => console.error('[Server]', err))
      warnings.forEach(err => console.warn('[Server]', err))

      if (errors.length === 0) {
        serverManifest = JSON.parse(assets['../quasar.server-manifest.json'].source())
        update()
      }

      cb()
    })

    clientCompiler.hooks.done.tapAsync('done-compiling', ({ compilation: { errors, warnings, assets }}, cb) => {
      errors.forEach(err => console.error('[Client]', err))
      warnings.forEach(err => console.warn('[Client]', err))

      if (errors.length === 0) {
        if (cfg.ctx.mode.pwa) {
          pwa = {
            manifest: assets['manifest.json'].source(),
            serviceWorker: assets['service-worker.js'].source()
          }
        }

        clientManifest = JSON.parse(assets['../quasar.client-manifest.json'].source())
        update()
      }

      cb()
    })

    const serverCompilerWatcher = serverCompiler.watch({}, () => {})

    const originalAfter = cfg.devServer.after

    // start building & launch server
    const server = new WebpackDevServer(clientCompiler, {
      ...cfg.devServer,

      after: app => {
        if (cfg.ctx.mode.pwa) {
          app.use(cfg.build.publicPath + 'manifest.json', (_, res) => {
            res.setHeader('Content-Type', 'application/json')
            res.send(pwa.manifest)
          })
          app.use(cfg.build.publicPath + 'service-worker.js', (_, res) => {
            res.setHeader('Content-Type', 'text/javascript')
            res.send(pwa.serviceWorker)
          })
        }

        if (cfg.build.ignorePublicFolder !== true) {
          app.use(cfg.build.publicPath, express.static(appPaths.resolve.app('public'), {
            maxAge: 0
          }))
        }

        originalAfter && originalAfter(app)

        SsrExtension.getModule().extendApp({
          app,
          ssr: {
            // TODO vue3
            renderToString () {},
            settings: Object.assign(
              {},
              JSON.parse(cfg.ssr.__templateOpts),
              { debug: true }
            )
          }
        })

        app.get(cfg.build.publicPath + '*', render)
      }
    })

    readyPromise.then(() => {
      server.listen(cfg.devServer.port, cfg.devServer.host, () => {
        resolve()
        if (cfg.__devServer.open) {
          openBrowser({ url: cfg.build.APP_URL, opts: cfg.__devServer.openOptions })
        }
      })
    })

    this.__cleanup = () => {
      this.__cleanup = null
      htmlWatcher.close()
      return Promise.all([
        new Promise(resolve => { server.close(resolve) }),
        new Promise(resolve => { serverCompilerWatcher.close(resolve) })
      ])
    }
  }

  stop () {
    if (this.__cleanup) {
      log(`Shutting down`)
      return this.__cleanup()
    }
  }
}

import path from 'path'
import fs from 'fs'
import colors from 'picocolors'
import { loadEnv } from 'vite'
import type { AddressInfo } from 'net'
import type {
  Plugin,
  UserConfig,
  ConfigEnv,
  ResolvedConfig,
  PluginOption
} from 'vite'
import fullReload from 'vite-plugin-full-reload'
import type { Config as FullReloadConfig } from 'vite-plugin-full-reload'

export interface PluginConfig {
  input: string | string[]
  publicDirectory?: string
  buildDirectory?: string
  refresh?: boolean | string | string[] | RefreshConfig | RefreshConfig[]
}

interface RefreshConfig {
  paths: string[]
  config?: FullReloadConfig
}

interface ThinkPlugin extends Plugin {
  config: (config: UserConfig, env: ConfigEnv) => UserConfig
}

export const refreshPaths = [
  'resources/views/**',
  'routes/**'
]

type ThinkConfig = string | string[] | PluginConfig
type DevServerUrl = `${'http' | 'https'}://${string}:${number}`

let exitHandlersBound = false

const think = (config: ThinkConfig): [ThinkPlugin, ...Plugin[]]  => {
  const pluginConfig = resolvePluginConfig(config)

  return [
    resolveThinkPlugin(pluginConfig),
    ...resolveFullReloadConfig(pluginConfig) as Plugin[]
  ]
}

const resolveThinkPlugin = (pluginConfig: Required<PluginConfig>): ThinkPlugin => {
  let viteDevServerUrl: DevServerUrl
  let resolvedConfig: ResolvedConfig

  const defaultAliases: Record<string, string> = {
    '@': '/resources'
  }

  return {
    name: 'think-vite-plugin',
    enforce: 'post',
    config: (userConfig, { command, mode }) => {
      const env = loadEnv(mode, userConfig.envDir || process.cwd(), '')
      const assetUrl = env.ASSET_URL ?? ''

      return {
        base: command === 'build' ? resolveBase(pluginConfig, assetUrl) : '',
        publicDir: false,
        build: {
          manifest: true,
          outDir: userConfig.build?.outDir ?? resolveOutDir(pluginConfig),
          rollupOptions: {
            input: userConfig.build?.rollupOptions?.input ?? resolveInput(pluginConfig)
          }
        },
        server: {
          origin: '__think_vite_placeholder__'
        },
        resolve: {
          alias: Array.isArray(userConfig.resolve?.alias)
            ? [
              ...userConfig.resolve?.alias ?? [],
              ...Object.keys(defaultAliases).map(alias => ({
                find: alias,
                replacement: defaultAliases[alias]
              }))
            ] : {
              ...defaultAliases,
              ...userConfig.resolve?.alias
            }
        }
      }
    },
    configResolved (config){
      resolvedConfig = config
    },
    transform(code){
      if (resolvedConfig.command === 'serve') {
        return code.replace(/__think_vite_placeholder__/g, viteDevServerUrl)
      }
    },
    configureServer(server) {
      const hotFile = path.join(pluginConfig.publicDirectory, 'think.vite.server')
      const envDir = resolvedConfig.envDir || process.cwd()
      const appUrl = loadEnv(resolvedConfig.mode, envDir, 'APP_URL').APP_URL ?? 'undefined'

      server.httpServer?.once('listening', () => {
        const address = server.httpServer?.address()

        if (isAddressInfo(address)) {
          viteDevServerUrl = resolveDevServerUrl(address as AddressInfo, server.config)
          fs.writeFileSync(hotFile, viteDevServerUrl)
        }

        setTimeout(() => {
          const THINK = colors.red(`${colors.bold('THINK')} ${thinkVersion()}`)
          const PLUGIN = colors.green(`${colors.bold('PLUGIN')} v${pluginVersion()}`)
          const APP_URL = `${colors.bold('APP_URL')}: ${colors.cyan(appUrl.replace(/:(\d+)/, (_, port) => `:${colors.bold(port)}`))}`
          server.config.logger.info(`\n  ${THINK}  ${PLUGIN}`)
          server.config.logger.info('')
          server.config.logger.info(`  ${colors.green('➜')}  ${APP_URL}`)
        }, 100)
      })

      if (exitHandlersBound) {
        return
      }

      const clean = () => {
        if (fs.existsSync(hotFile)) {
          fs.rmSync(hotFile)
        }
      }

      process.on('exit', clean)
      process.on('SIGINT', process.exit)
      process.on('SIGTERM', process.exit)
      process.on('SIGHUP', process.exit)

      exitHandlersBound = true

      return () => server.middlewares.use((req, res, next) => {
        if (req.url === '/index.html') {
          res.statusCode = 404
        }
        const str = fs.readFileSync(path.join(__dirname, 'dev-server-index.html'))
          .toString()
          .replace(/{{ APP_URL }}/g, appUrl)
        res.end(str)
        next()
      })
    }
  }
}

const resolvePluginConfig = (config: ThinkConfig): Required<PluginConfig> => {

  if (typeof config === 'undefined') {
    throw new Error('think-vite-plugin: missing configuration.')
  }

  if (typeof config === 'string' || Array.isArray(config)) {
    config = { input: config }
  }

  if (typeof config.input === 'undefined') {
    throw new Error('think-vite-plugin: missing configuration for "input".')
  }

  if (typeof config.publicDirectory === 'string') {
    config.publicDirectory = config.publicDirectory.trim().replace(/^\/+/, '')
    if (config.publicDirectory === '') {
      throw new Error('think-vite-plugin: publicDirectory must be a subdirectory. E.g. \'public\'.')
    }
  }

  if (typeof config.buildDirectory === 'string') {
    config.buildDirectory = config.buildDirectory.trim().replace(/^\/+/, '').replace(/\/+$/, '')
    if (config.buildDirectory === '') {
      throw new Error('think-vite-plugin: buildDirectory must be a subdirectory. E.g. \'build\'.')
    }
  }

  if (config.refresh === true) {
    config.refresh = [{ paths: refreshPaths }]
  }

  return {
    input: config.input,
    publicDirectory: config.publicDirectory ?? 'public',
    buildDirectory: config.buildDirectory ?? 'build',
    refresh: config.refresh ?? false
  }
}

/**
 * 配置 fullReload 目录
 * @param config
 */
const resolveFullReloadConfig = ({ refresh: config }: Required<PluginConfig>): PluginOption[] => {

  if (typeof config === 'boolean') {
    return [];
  }

  if (typeof config === 'string') {
    config = [{ paths: [config]}]
  }

  if (! Array.isArray(config)) {
    config = [config]
  }

  if (config.some(c => typeof c === 'string')) {
    config = [{ paths: config }] as RefreshConfig[]
  }

  return (config as RefreshConfig[]).flatMap(c => {
    const plugin = fullReload(c.paths, c.config)
    // @ts-ignore
    plugin.__think_plugin_config = c
    return plugin
  })
}

/**
 * 获取 think 版本号
 */
const thinkVersion = (): string => {
  try {
    const composer = JSON.parse(fs.readFileSync('composer.lock').toString())
    return composer.packages?.find((packages: {name: string}) => packages.name === 'topthink/framework')?.version ?? ''
  } catch {
    return ''
  }
}

/**
 * 获取 plugin 版本号
 */
const pluginVersion = (): string => {
  try {
    const pkg = fs.readFileSync(path.join(__dirname, '../package.json'))
    return JSON.parse(pkg.toString())?.version
  } catch {
    return ''
  }
}

const resolveBase = (config: Required<PluginConfig>, assetUrl: string) => {
  return assetUrl + (!assetUrl.endsWith('/') ? '/' : '') + config.buildDirectory + '/'
}

const resolveOutDir = (config: Required<PluginConfig>): string | undefined => {
  return path.join(config.publicDirectory, config.buildDirectory)
}

const resolveInput = (config: Required<PluginConfig>): string | string[] | undefined => {
  return config.input
}

const resolveDevServerUrl = (address: AddressInfo, config: ResolvedConfig): DevServerUrl => {
  const configHmrProtocol = typeof config.server.hmr === 'object' ? config.server.hmr.protocol : null
  const clientProtocol = configHmrProtocol ? (configHmrProtocol === 'wss' ? 'https' : 'http') : null
  const serverProtocol = config.server.https ? 'https' : 'http'
  const protocol = clientProtocol ?? serverProtocol

  const configHmrHost = typeof config.server.hmr === 'object' ? config.server.hmr.host : null
  const configHost = typeof config.server.host === 'string' ? config.server.host : null
  const serverAddress = isIpv6(address) ? `[${address.address}]` : address.address
  const host = configHmrHost ?? configHost ?? serverAddress

  const configHmrClientPort = typeof config.server.hmr === 'object' ? config.server.hmr.clientPort : null
  const port = configHmrClientPort ?? address.port

  return `${protocol}://${host}:${port}`
}

const isIpv6 = (address: AddressInfo): boolean => {
  // @ts-ignore-next-line
  return address.family === 'IPv6' || address.family === 6;
}

const isAddressInfo = (x: string|AddressInfo|null|undefined): boolean => {
  return typeof x === 'object'
}

export default think
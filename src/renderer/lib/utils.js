import Mac from './mac.js'
// const { Mac } = require('./mac.js')
const { URL } = require('url')
const http = require('http')
const https = require('https')
const os = require('os')
const path = require('path')
const fs = require('fs-extra')
const dns = require('dns')
const crypto = require('crypto')
const zlib = require('zlib')
const NetcatClient = require('netcat').client
const { exec } = require('child_process')
const sudo = require('sudo-prompt')
const winston = require('winston')

if (process.env.NODE_ENV === 'development') {
  winston.level = 'debug'
}

const platform = os.platform()

function parseSsrURI (uri, templateProfile) {
  // d3d3LmV4YW1wbGUuY29tOjk5OTk6YXV0aF9hZXMxMjhfbWQ1OmNoYWNoYTIwOnRsczEuMl90aWNrZXRfYXV0aDphR0Z3Y0hramMzTnlJekl3TVRjLz9vYmZzcGFyYW09JnByb3RvcGFyYW09TXpJJnJlbWFya3M9UVc1a2NtOXBaQ0JUVTFJZ1JHVm1ZWFZzZEEmZ3JvdXA9ZG5Cego
  // www.example.com:9999:auth_aes128_md5:chacha20:tls1.2_ticket_auth:aGFwcHkjc3NyIzIwMTc/?obfsparam=&protoparam=MzI&remarks=QW5kcm9pZCBTU1IgRGVmYXVsdA&group=dnBz
  const profile = Object.assign({}, templateProfile)
  profile.proxies = 'ssr'

  const decodedString = Buffer.from(uri.substr(6), 'base64').toString()

  const separatorIndex = decodedString.indexOf('/?')

  const mainCfgPart = decodedString.substr(0, separatorIndex).split(':')

  // 解码 commonCfgPart 数组的最后一项
  mainCfgPart[mainCfgPart.length - 1] = Buffer.from(mainCfgPart[mainCfgPart.length - 1], 'base64').toString()

  ;[
    profile.shadowsocksr.server,
    profile.shadowsocksr.server_port,
    profile.shadowsocksr.protocol,
    profile.shadowsocksr.method,
    profile.shadowsocksr.obfs,
    profile.shadowsocksr.password
  ] = mainCfgPart

  const secondaryCfgPart = decodedString.substr(separatorIndex + 2).split('&')
  secondaryCfgPart.forEach((pair) => {
    let [key, value] = pair.split('=')
    const decodedValue = Buffer.from(value, 'base64').toString()
    switch (key) {
      case 'obfsparam':
        profile.shadowsocksr.obfs_param = decodedValue
        break
      case 'protoparam':
        profile.shadowsocksr.protocol_param = decodedValue
        break
      case 'remarks':
        profile.name = decodedValue
        break
      case 'group':
        break
      default:
        profile.shadowsocksr.others += `${key}=${decodedValue};`
    }
  })

  return profile
}
function parseSsURI (uri, templateProfile) {
  // https://shadowsocks.org/en/config/quick-guide.html
  // ss://YmYtY2ZiOnRlc3RAMTkyLjE2OC4xMDAuMTo4ODg4Cg#example-server
  const profile = Object.assign({}, templateProfile)

  const lastSharpIndex = uri.lastIndexOf('#')

  let configStrLen
  if (lastSharpIndex > 0) {
    profile.name = Buffer.from(uri.substr(lastSharpIndex + 1), 'utf8').toString()
    configStrLen = lastSharpIndex - 5
  }
  // bf-cfb:test@192.168.100.1:8888
  const decodedString = Buffer.from(uri.substr(5, configStrLen), 'base64').toString()

  const configArray = decodedString.split('@')

  ;[
    profile.shadowsocks.server,
    profile.shadowsocks.server_port
  ] = configArray[1].split(':')
  ;[
    profile.shadowsocks.method,
    profile.shadowsocks.password
  ] = configArray[0].split(':')
  profile.proxies = 'ss'

  return profile
}
function parseSsSIP002URI (uri, templateProfile) {
  // https://shadowsocks.org/en/spec/SIP002-URI-Scheme.html
  // ss://YmYtY2ZiOnRlc3Q@192.168.100.1:8888/?plugin=url-encoded-plugin-argument-value&unsupported-arguments=should-be-ignored#Dummy+profile+name
  const profile = Object.assign({}, templateProfile)

  const firstAtIndex = uri.indexOf('@')
  // bf-cfb:test
  const decodedString = Buffer.from(uri.substr(5, firstAtIndex - 5), 'base64').toString()
  winston.debug('decodedString', decodedString)
  ;[
    profile.shadowsocks.method,
    profile.shadowsocks.password
  ] = decodedString.split(':')

  const serverAndPortPattern = /@(.*:\d+)/ig
  const serverAndPortStr = serverAndPortPattern.exec(uri)[1]
  winston.debug('serverAndPortStr', serverAndPortStr)

  ;[
    profile.shadowsocks.server,
    profile.shadowsocks.server_port
  ] = serverAndPortStr.split(':')
  profile.proxies = 'ss'

  const pluginIndex = uri.indexOf('plugin=')
  if (pluginIndex > 0) {
    const lastSharpIndex = uri.lastIndexOf('#')
    profile.name = uri.substr(lastSharpIndex + 1)
    const pluginCfgStrIndex = pluginIndex + 'plugin='.length
    const pluginCfgStrLen = lastSharpIndex < 0 ? undefined : lastSharpIndex - pluginCfgStrIndex
    const pluginCfgStr = uri.substr(pluginCfgStrIndex, pluginCfgStrLen)
    winston.debug('pluginCfgStr', pluginCfgStr)

    const pluginCfgArray = decodeURIComponent(pluginCfgStr).split(';')
    if (pluginCfgArray[0] !== 'kcptun') {
      winston.error(`unsupported plugin: ${pluginCfgArray[0]}`)
      return profile
    }

    profile.proxies = 'ssKt'
    let others = ''
    pluginCfgArray.slice(1).forEach(pair => {
      const [key, value] = pair.split('=')
      switch (key) {
        case 'mode':
        case 'key':
        case 'crypt':
          profile.kcptun[key] = value
          break
        default:
          others += `${pair};`
      }
    })
    profile.kcptun.server = profile.shadowsocks.server
    profile.kcptun.server_port = profile.shadowsocks.server_port
    // 用ss+kt代理时, 也要填ss的服务器端口号, 因为tunnelDNS/relayUDP都需要用
    profile.shadowsocks.server_port = ''
    if (others !== '') {
      profile.kcptun.others = others
    }
  }
  return profile
}

class Utils {
  static execute (command) {
    return new Promise((resolve, reject) => {
      exec(command, (error, stdout, stderr) => {
        if (error) {
          reject(error)
        } else {
          resolve(stdout || stderr)
        }
      })
    })
  }

  /*
   * @param {string} 待执行命令
   * @param {object} options 选项, 可包含name, icns属性
   */
  static sudoExec (cmd, options) {
    return new Promise((resolve, reject) => {
      sudo.exec(cmd, options, (err, stdout, stderr) => {
        if (err) {
          reject(err)
        } else {
          resolve(stdout || stderr)
        }
      })
    })
  }

  static downloadFile (src) {
    const protocol = (new URL(src)).protocol
    const method = protocol === 'https:' ? https : http
    const tmp = path.join(os.tmpdir(), path.basename(src))
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(tmp)
      method.get(src, (response) => {
        response.pipe(file)
        file.on('finish', () => {
          file.close()
          return resolve(tmp)
        })
      }).on('error', (err) => {
        fs.unlink(tmp)
        return reject(err)
      })
    })
  }

  static resolveDomain (domain) {
    const ipPatthen = /^\d+.\d+.\d+.\d+$/ig
    if (ipPatthen.test(domain)) {
      return Promise.resolve(domain)
    }
    return new Promise((resolve, reject) => {
      dns.lookup(domain, { family: 4 }, (err, address, family) => {
        if (err) {
          reject(err)
        }
        resolve(address)
      })
    })
  }

  static gunzip (input, output) {
    const gunzip = zlib.createGunzip()
    const inStream = fs.createReadStream(input)
    const outStream = fs.createWriteStream(output)
    inStream.pipe(gunzip).pipe(outStream)
    return new Promise((resolve, reject) => {
      outStream.on('finish', function () {
        resolve(output)
      })
    })
  }

  static wait (time) {
    return new Promise(resolve => setTimeout(resolve, time))
  }

  static async hashFile (file) {
    try {
      fs.statSync(file)
    } catch (err) {
      winston.error(err)
      return Promise.resolve('')
    }
    const algo = 'sha256'
    const shasum = crypto.createHash(algo)
    const s = fs.ReadStream(file)
    return new Promise((resolve, reject) => {
      s.on('data', function (d) { shasum.update(d) })
      s.on('end', function () {
        var d = shasum.digest('hex')
        resolve(d)
      })
    })
  }

  static getAppDir () {
    return process.env.APPDATA || (platform === 'darwin' ? path.join(process.env.HOME, 'Library', 'Application Support') : '/var/local')
  }

  static getActiveAdapter () {
    switch (platform) {
      case 'darwin':
        return Mac.getActiveAdapter()
      default:
        return Mac.getActiveAdapter()
    }
  }

  static async serialExec (file, command) {
    const nc = new NetcatClient()
    nc.unixSocket(file).enc('utf8')
      .connect()
      .send(`\n\n\n\n\n\n${command}\n\n`)
      .close()
  }

  static changeRouteTo (ip) {
    switch (platform) {
      case 'darwin':
        return Mac.changeRouteTo(ip)
    }
  }
  static getCurrentDns () {
    switch (platform) {
      case 'darwin':
        return Mac.getCurrentDns()
    }
  }
  static getCurrentGateway () {
    switch (platform) {
      case 'darwin':
        return Mac.getCurrentGateway()
    }
  }
  static resetRoute () {
    switch (platform) {
      case 'darwin':
        return Mac.resetRoute()
    }
  }
  static getProxiesText (proxies) {
    const dict = {
      ss: 'Shadowsocks',
      ssr: 'ShadowsocksR',
      ssKt: 'Shadowsocks + Kcptun',
      ssrKt: 'ShadowsocksR + Kcptun'
    }
    return dict[proxies]
  }

  static getModeText (mode) {
    const dict = {
      global: '全局模式',
      whitelist: '绕过白名单',
      blacklist: '仅代理黑名单',
      none: '无代理'
    }
    return dict[mode]
  }

  static configureLog (fPath) {
    const transports = []
    transports.push(new (winston.transports.File)({
      filename: fPath,
      level: 'info'
    }))
    if (process.env.NODE_ENV === 'development') {
      transports.push(new (winston.transports.Console)({
        level: 'debug'
      }))
    }
    winston.configure({ transports })
  }

  static parseProfileURI (uri, templateProfile) {
    const type = uri.substr(0, uri.indexOf(':'))
    if (type === 'ssr') {
      return parseSsrURI(uri, templateProfile)
    }
    if (type === 'ss') {
      if (uri.indexOf('@') > 0) {
        return parseSsSIP002URI(uri, templateProfile)
      }
      return parseSsURI(uri, templateProfile)
    }
    return null
  }
}

export default Utils

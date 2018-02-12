import * as fs from 'fs';
import * as path from 'path';
import * as _ from 'lodash';
import * as url from 'url';
import * as http from 'http';
import * as os from 'os';
import * as httpProxy from 'http-proxy';
import * as express from 'express';
import * as multer from 'multer';
import { VM } from 'vm2';
import { launch } from 'puppeteer';
import { setInterval } from 'timers';

const cpuStats = require('cpu-stats');
const debug = require('debug')('browserless/chrome');
const request = require('request');
const queue = require('queue');
const bodyParser = require('body-parser');
const version = require('../version.json');
const protocol = require('../protocol.json');

const metricsHTML = fs.readFileSync(path.join(__dirname, '..', '/public/metrics.html'), { encoding: 'utf8' });

const chromeTarget = () => {
  var text = '';
  var possible = 'ABCDEF0123456789';

  for (var i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }

  return `/devtools/page/${text}`;
};

const asyncMiddleware = (handler) => {
  return (req, socket, head) => {
    Promise.resolve(handler(req, socket, head))
      .catch((error) => {
        debug(`ERROR: ${error}`);
        socket.write('HTTP/1.1 429 Too Many Requests\r\n');
        socket.end();
      });
  }
};

const thiryMinutes = 30 * 60 * 1000;
const fiveMinutes = 5 * 60 * 1000;
const maxStats = 12 * 24 * 7; // One week @ 5-min intervals

export interface IOptions {
  connectionTimeout: number;
  port: number;
  maxConcurrentSessions: number;
  maxQueueLength: number;
  prebootChrome: boolean;
  token: string | null;
  rejectAlertURL: string | null;
  queuedAlertURL: string | null;
  timeoutAlertURL: string | null;
}

interface IChrome {
  wsEndpoint: () => string;
  newPage: () => any;
  close: () => void;
}

interface IStats {
  date: number | null;
  requests: number;
  queued: number;
  rejected: number;
  timedout: number;
  cpuPercent: number;
  memoryPercent: number;
};

export class Chrome {
  public port: number;
  public maxConcurrentSessions: number;
  public maxQueueLength: number;
  public connectionTimeout: number;
  public token: string | null;

  private proxy: any;
  private prebootChrome: boolean;
  private chromeSwarm: Promise<IChrome>[];
  private queue: any;
  private server: any;
  private debuggerScripts: any;

  readonly rejectHook: Function;
  readonly queueHook: Function;
  readonly timeoutHook: Function;

  private stats: IStats[];
  private currentStat: IStats;

  constructor(opts: IOptions) {
    this.port = opts.port;
    this.maxConcurrentSessions = opts.maxConcurrentSessions;
    this.maxQueueLength = opts.maxQueueLength + opts.maxConcurrentSessions;
    this.connectionTimeout = opts.connectionTimeout;
    this.prebootChrome = opts.prebootChrome;
    this.token = opts.token;

    this.chromeSwarm = [];
    this.stats = []
    this.debuggerScripts = new Map();

    this.proxy = new httpProxy.createProxyServer();
    this.proxy.on('error', function (err, _req, res) {
      if (res.writeHead) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
      }

      if (res.close) {
        res.close();
      }

      debug(`Issue communicating with Chrome: "${err.message}"`);
      res.end(`Issue communicating with Chrome`);
    });

    this.queue = queue({
      concurrency: this.maxConcurrentSessions,
      timeout: this.connectionTimeout,
      autostart: true
    });

    this.queue.on('success', this.addToSwarm.bind(this));
    this.queue.on('error', this.addToSwarm.bind(this));
    this.queue.on('timeout', this.onTimedOut.bind(this));

    this.queueHook = opts.queuedAlertURL ?
      _.debounce(() => {
        debug(`Calling webhook for queued session(s): ${opts.queuedAlertURL}`);
        request(opts.queuedAlertURL, _.noop);
      }, thiryMinutes, { leading: true, trailing: false }) :
      _.noop;

    this.rejectHook = opts.rejectAlertURL ?
      _.debounce(() => {
        debug(`Calling webhook for rejected session(s): ${opts.rejectAlertURL}`);
        request(opts.rejectAlertURL, _.noop);
      }, thiryMinutes, { leading: true, trailing: false }) :
      _.noop;

    this.timeoutHook = opts.timeoutAlertURL ?
      _.debounce(() => {
        debug(`Calling webhook for timed-out session(s): ${opts.rejectAlertURL}`);
        request(opts.rejectAlertURL, _.noop);
      }, thiryMinutes, { leading: true, trailing: false }) :
      _.noop;

    debug({
      port: this.port,
      token: this.token,
      connectionTimeout: this.connectionTimeout,
      maxQueueLength: this.maxQueueLength,
      maxConcurrentSessions: this.maxConcurrentSessions,
      rejectAlertURL: opts.rejectAlertURL,
      timeoutAlertURL: opts.timeoutAlertURL,
      queuedAlertURL: opts.queuedAlertURL,
      prebootChrome: this.prebootChrome,
    }, `Final Options`);

    setInterval(this.recordMetrics.bind(this), fiveMinutes);

    if (this.prebootChrome) {
      for (let i = 0; i < this.maxConcurrentSessions; i++) {
        this.chromeSwarm.push(this.launchChrome());
      }
    }

    this.resetCurrentStat();
  }

  private onRequest(req) {
    debug(`${req.url}: Inbound WebSocket request. ${this.queue.length} in queue.`);
    this.currentStat.requests = this.currentStat.requests + 1;
  }

  private onTimedOut(next, job) {
    debug(`Timeout hit for session, closing. ${this.queue.length} in queue.`);
    job.close('HTTP/1.1 408 Request has timed out\r\n');
    this.currentStat.timedout = this.currentStat.timedout + 1;
    this.timeoutHook();
    this.addToSwarm();
    next();
  }

  private onQueued(req) {
    debug(`${req.url}: Concurrency limit hit, queueing`);
    this.currentStat.queued = this.currentStat.queued + 1;
    this.queueHook();
  }

  private onRejected(req, socket, message) {
    debug(`${req.url}: ${message}`);
    this.closeSocket(socket, `${message}\r\n`);
    this.currentStat.rejected = this.currentStat.rejected + 1;
    this.rejectHook();
  }

  private resetCurrentStat() {
    this.currentStat = {
      rejected: 0,
      queued: 0,
      requests: 0,
      timedout: 0,
      cpuPercent: 0,
      memoryPercent: 0,
      date: null,
    };
  }

  private recordMetrics() {
    cpuStats(100, (_err, results) => {
      this.stats.push(_.assign({}, this.currentStat, {
        date: Date.now(),
        memoryPercent: (1 - (os.freemem() / os.totalmem())) * 100,
        cpuPercent: results.reduce((accum, stat) => accum + stat.cpu, 0) / results.length,
      }));

      this.resetCurrentStat();

      if (this.stats.length > maxStats) {
        this.stats.shift();
      }
    });
  }

  private addToSwarm() {
    if (this.prebootChrome && (this.chromeSwarm.length < this.maxConcurrentSessions)) {
      this.chromeSwarm.push(this.launchChrome());
      debug(`Added Chrome instance to swarm, ${this.chromeSwarm.length} online`);
    }
  }

  private closeSocket(socket: any, message: string) {
    debug(`Closing socket.`);
    socket.end(message);
    socket.destroy();
  }

  private async launchChrome(flags:string[] = []): Promise<IChrome> {
    const start = Date.now();
    debug('Chrome Starting');
    return launch({
      args: flags.concat(['--no-sandbox', '--disable-dev-shm-usage']),
    })
      .then((chrome) => {
        debug(`Chrome launched ${Date.now() - start}ms`);
        return chrome;
      })
      .catch((error) => console.error(error));
  }

  public async startServer(): Promise<any> {
    const app = express();
    const upload = multer();

    app.use(bodyParser.text());
    app.use('/', express.static('public'));
    app.use((req, res, next) => {
      if (this.token && req.query.token !== this.token) {
        return res.sendStatus(403);
      }
      next();
    });
    app.get('/json/version', (_req, res) => res.json(version));
    app.get('/json/protocol', (_req, res) => res.json(protocol));
    app.get('/metrics', (_req, res) => res.send(
      metricsHTML
        .replace('$stats', JSON.stringify(this.stats))
        .replace('$version', JSON.stringify(_.omit(version, 'User-Agent')))
      )
    );

    app.post('/execute', upload.single('file'), async (req, res) => {
      if (!req.file) {
        res.status(400).send();
      }
      const targetId = chromeTarget();
      const code = `
      (async() => {
        ${req.file.buffer.toString().replace('debugger', 'page.evaluate(() => { debugger; })')}
      })().catch((error) => {
        console.error('Puppeteer Runtime Error:', error.stack);
      });`;

      debug(`/execute: Script uploaded\n${code}`);

      this.debuggerScripts.set(targetId, code);

      res.json({
        targetId,
        debuggerVersion: version['Debugger-Version']
      });
    });

    app.get('/json*', asyncMiddleware(async (req, res) => {
      const targetId = chromeTarget();
      const baseUrl = req.get('host');
      const protocol = req.protocol.includes('s') ? 'wss': 'ws';

      debug(`${req.url}: JSON protocol request.`);

      res.json([{
        targetId,
        description: '',
        devtoolsFrontendUrl: `/devtools/inspector.html?${protocol}=${baseUrl}${targetId}`,
        title: 'about:blank',
        type: 'page',
        url: 'about:blank',
        webSocketDebuggerUrl: `${protocol}://${baseUrl}${targetId}`
     }]);
    }));

    app.post('/evaluate', asyncMiddleware(async (req, res) => {
      if (!req.body) res.status(400).send();

      const chrome = await this.launchChrome();
      const page = await chrome.newPage();
      const code = `(${req.body})(page, callback);`;
      const callback = (error, data) => {
        if (error) {
          res.status(500).send(error);
        }
        res.json({ data });
      };
      const sandbox = { page, callback };
      const vm = new VM({ sandbox, timeout: this.connectionTimeout });

      vm.run(code);
    }));

    return this.server = http
      .createServer(app)
      .on('upgrade', asyncMiddleware(async(req, socket, head) => {
        const parsedUrl = url.parse(req.url, true);
        const queueLength = this.queue.length;

        this.onRequest(req);

        if (this.token && parsedUrl.query.token !== this.token) {
          return this.onRejected(req, socket, `HTTP/1.1 403 Forbidden`);
        }

        if (queueLength >= this.maxQueueLength) {
          return this.onRejected(req, socket, `HTTP/1.1 429 Too Many Requests`);
        }

        if (queueLength >= this.maxConcurrentSessions) {
          this.onQueued(req);
        }

        const job:any = (done: () => {}) => {
          const route = parsedUrl.pathname || '/';

          const flags = _.chain(parsedUrl.query)
            .pickBy((_value, param) => _.startsWith(param, '--'))
            .map((value, key) => `${key}${value ? `=${value}` : ''}`)
            .value();

          const canUseChromeSwarm = !flags.length && !!this.chromeSwarm.length;
          const launchPromise = canUseChromeSwarm ? this.chromeSwarm.shift() : this.launchChrome(flags);

          debug(`${req.url}: WebSocket upgrade.`);

          (launchPromise || this.launchChrome())
            .then(async (chrome) => {
              const browserWsEndpoint = chrome.wsEndpoint();

              debug(`${req.url}: Chrome Launched.`);

              socket.on('close', () => {
                debug(`${req.url}: Session closed, stopping Chrome. ${this.queue.length} in queue`);
                chrome.close();
                done();
              });

              if (!route.includes('/devtools/page')) {
                debug(`${req.url}: Proxying request to /devtools/browser route: ${browserWsEndpoint}.`);
                req.url = route;

                return browserWsEndpoint;
              }

              const page = await chrome.newPage();
              const port = url.parse(browserWsEndpoint).port;
              const pageLocation = `/devtools/page/${page._target._targetId}`;

              debug(`${req.url}: Proxying request to /devtools/page route: ${pageLocation}.`);

              if (this.debuggerScripts.has(route)) {
                const code = this.debuggerScripts.get(route);
                debug(`${req.url}: Loading prior-uploaded script to execute for route.`);

                const sandbox = {
                  page,
                  console: {
                    log: (...args) => page.evaluate((...args) => console.log(...args), ...args),
                    error: (...args) => page.evaluate((...args) => console.error(...args), ...args),
                    debug: (...args) => page.evaluate((...args) => console.debug(...args), ...args),
                  },
                };

                const vm = new VM({
                  sandbox,
                  timeout: this.connectionTimeout
                });

                this.debuggerScripts.delete(route);
                vm.run(code);
              }

              req.url = pageLocation;

              return `ws://127.0.0.1:${port}`;
            })
            .then((target) => this.proxy.ws(req, socket, head, { target }));
        };

        job.close = (message: string) => this.closeSocket(socket, message);

        this.queue.push(job);
      }))
      .listen(this.port);
  }

  public async close() {
    this.server.close();
    this.proxy.close();
  }
}

import express, { Request, Response, NextFunction } from 'express';
import { Server } from 'http';
import { DatabaseService } from './Database';

interface SignalPayload {
  timestamp: number;
  state: string;
}

export class ApiServer {
  private app: express.Application;
  private server: Server | null = null;
  private db: DatabaseService;
  private port: number;
  private apiKey: string;

  constructor(db: DatabaseService, port: number = 3000, apiKey: string = '') {
    this.db = db;
    this.port = port;
    this.apiKey = apiKey;
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    // JSON body parser
    this.app.use(express.json());

    // Request logging
    this.app.use((req: Request, _res: Response, next: NextFunction) => {
      const timestamp = new Date().toISOString();
      console.log(`[API] ${timestamp} ${req.method} ${req.path}`);
      if (req.body && Object.keys(req.body).length > 0) {
        console.log(`[API] Body: ${JSON.stringify(req.body)}`);
      }
      next();
    });

    // API key authentication (if configured)
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      // Skip auth if no API key configured
      if (!this.apiKey) {
        return next();
      }

      const providedKey = req.headers['x-api-key'];
      if (providedKey !== this.apiKey) {
        console.log(`[API] Unauthorized request from ${req.ip}`);
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      next();
    });
  }

  private setupRoutes(): void {
    // Root endpoint
    this.app.get('/', (_req: Request, res: Response) => {
      res.send('lfg');
    });

    // Health check
    this.app.get('/api/health', (_req: Request, res: Response) => {
      res.json({ status: 'ok', timestamp: Date.now() });
    });

    // Receive signal from external system
    this.app.post('/api/signal', (req: Request, res: Response) => {
      try {
        const payload = req.body as SignalPayload;

        // Validate payload
        if (!payload.timestamp || !payload.state) {
          console.log('[API] Invalid payload: missing timestamp or state');
          res.status(400).json({ error: 'Invalid payload: missing timestamp or state' });
          return;
        }

        if (typeof payload.timestamp !== 'number') {
          console.log('[API] Invalid payload: timestamp must be a number');
          res.status(400).json({ error: 'Invalid payload: timestamp must be a number' });
          return;
        }

        // Insert signal into database
        const result = this.db.insertSignal(payload.timestamp, payload.state);

        console.log(`[API] Signal recorded: state=${payload.state}, timestamp=${payload.timestamp}, market_start=${result.marketStart}`);

        res.json({
          success: true,
          message: 'Signal recorded',
          market_start: result.marketStart,
        });
      } catch (error) {
        console.error('[API] Error processing signal:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Get latest signal (for debugging)
    this.app.get('/api/signal/latest', (_req: Request, res: Response) => {
      try {
        const signal = this.db.getLatestSignal();
        if (signal) {
          res.json({ success: true, signal });
        } else {
          res.json({ success: true, signal: null, message: 'No signals recorded' });
        }
      } catch (error) {
        console.error('[API] Error getting latest signal:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Get signal for specific market (for debugging)
    this.app.get('/api/signal/:marketStart', (req: Request, res: Response) => {
      try {
        const marketStart = parseInt(req.params.marketStart, 10);
        if (isNaN(marketStart)) {
          res.status(400).json({ error: 'Invalid market_start parameter' });
          return;
        }

        const signal = this.db.getSignalForMarket(marketStart);
        if (signal) {
          res.json({ success: true, signal });
        } else {
          res.json({ success: true, signal: null, message: 'No signal for this market' });
        }
      } catch (error) {
        console.error('[API] Error getting signal:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, () => {
        console.log(`🌐 API server listening on port ${this.port}`);
        if (this.apiKey) {
          console.log('🔐 API key authentication enabled');
        } else {
          console.log('⚠️ API key authentication disabled (no API_KEY configured)');
        }
        resolve();
      });
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      console.log('🛑 API server stopped');
    }
  }
}

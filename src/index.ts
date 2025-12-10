import Fastify from 'fastify';
import { Server as HTTPServer } from 'http';
import { config } from './config/index.js';
import { logger } from './utils/logger.js';
import { initializeDatabase, closeDatabase } from './services/database.js';
import { initSocketServer } from './services/socket-server.js';
import { startQueueProcessor } from './services/queue-service.js';

const fastify = Fastify({
  logger: false,
});

fastify.get('/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

async function start() {
  try {
    logger.info('Starting BlockChess WebSocket Server...');

    await initializeDatabase();
    logger.info('Database initialized');

    await fastify.listen({
      port: config.server.port,
      host: config.server.host,
    });

    const httpServer = fastify.server as HTTPServer;
    const io = initSocketServer(httpServer);
    logger.info('Socket.IO server initialized');

    logger.info(`Server listening on ${config.server.host}:${config.server.port}`);
    logger.info(`Socket.IO path: ${config.socket.path}`);

    await startQueueProcessor(io);

    const shutdown = async () => {
      logger.info('Shutting down server...');
      await closeDatabase();
      await fastify.close();
      process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (error) {
    logger.error('Failed to start server', error);
    process.exit(1);
  }
}

start();


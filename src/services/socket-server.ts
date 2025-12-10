import { Server as SocketIOServer } from 'socket.io';
import { Server as HTTPServer } from 'http';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { addToQueue, getPool } from './database.js';
import {
  validateCreateGame,
  validateMakeMove,
  validateEndGame,
  validateMintNft,
} from '../utils/validation.js';
import {
  shouldEarnReward,
  getRewardByBadgeType,
  isRewardInQueue,
} from './reward-service.js';

let io: SocketIOServer | null = null;

export function initSocketServer(httpServer: HTTPServer): SocketIOServer {
  if (io) {
    return io;
  }

  io = new SocketIOServer(httpServer, {
    cors: {
      origin: config.socket.corsOrigin,
      methods: ['GET', 'POST'],
      credentials: true,
    },
    path: config.socket.path,
  });

  io.on('connection', (socket) => {
    logger.info(`Client connected: ${socket.id}`);

    socket.on('disconnect', () => {
      logger.info(`Client disconnected: ${socket.id}`);
    });

    socket.on('join-player-room', (playerSuiAddress: string) => {
      if (!playerSuiAddress || typeof playerSuiAddress !== 'string') {
        socket.emit('error', { error: 'Invalid player address' });
        return;
      }

      socket.join(`player:${playerSuiAddress}`);
      logger.info(`Player ${playerSuiAddress} joined room`);
    });

    socket.on('leave-player-room', (playerSuiAddress: string) => {
      if (!playerSuiAddress || typeof playerSuiAddress !== 'string') {
        return;
      }

      socket.leave(`player:${playerSuiAddress}`);
      logger.info(`Player ${playerSuiAddress} left room`);
    });

    socket.on('transaction:create_game', async (data: unknown) => {
      try {
        const validated = validateCreateGame(data);

        await addToQueue(
          validated.transactionId,
          'create_game',
          validated.playerAddress,
          validated.data as unknown as Record<string, unknown>,
          validated.gameId
        );

        socket.emit('transaction:queued', {
          transactionId: validated.transactionId,
          status: 'queued',
          timestamp: new Date().toISOString(),
        });

        logger.info(`Queued create_game transaction: ${validated.transactionId}`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Validation failed';
        logger.error('Failed to queue create_game transaction', error);
        socket.emit('error', {
          error: errorMessage,
          transactionId: (data as any).transactionId,
        });
      }
    });

    socket.on('transaction:make_move', async (data: unknown) => {
      try {
        const validated = validateMakeMove(data);
        const dataAny = data as any;
        const status = dataAny.status === 'waiting_for_object_id' ? 'waiting_for_object_id' : 'pending';

        const makeMoveData = validated.data as any;
        await addToQueue(
          validated.transactionId,
          'make_move',
          validated.playerAddress,
          validated.data as unknown as Record<string, unknown>,
          makeMoveData.gameId || null
        );

        // Update status if it's waiting for object_id
        if (status === 'waiting_for_object_id') {
          const { updateTransactionStatus } = await import('./database.js');
          await updateTransactionStatus(validated.transactionId, 'waiting_for_object_id');
        }

        socket.emit('transaction:queued', {
          transactionId: validated.transactionId,
          status: status === 'waiting_for_object_id' ? 'waiting_for_object_id' : 'queued',
          timestamp: new Date().toISOString(),
        });

        logger.info(`Queued make_move transaction: ${validated.transactionId} with status: ${status}`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Validation failed';
        logger.error('Failed to queue make_move transaction', error);
        socket.emit('error', {
          error: errorMessage,
          transactionId: (data as any).transactionId,
        });
      }
    });

    socket.on('transaction:end_game', async (data: unknown) => {
      try {
        const validated = validateEndGame(data);

        await addToQueue(
          validated.transactionId,
          'end_game',
          validated.playerAddress,
          validated.data as unknown as Record<string, unknown>
        );

        socket.emit('transaction:queued', {
          transactionId: validated.transactionId,
          status: 'queued',
          timestamp: new Date().toISOString(),
        });

        logger.info(`Queued end_game transaction: ${validated.transactionId}`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Validation failed';
        logger.error('Failed to queue end_game transaction', error);
        socket.emit('error', {
          error: errorMessage,
          transactionId: (data as any).transactionId,
        });
      }
    });

    socket.on('transaction:mint_nft', async (data: unknown) => {
      try {
        console.log('');
        console.log('');
        console.log('');
        console.log('');
        console.log('transaction:mint_nft', data);
        const validated = validateMintNft(data);
        console.log('validated', validated);

        await addToQueue(
          validated.transactionId,
          'mint_nft',
          validated.playerAddress,
          validated.data as unknown as Record<string, unknown>,
          undefined,
          validated.playerId
        );

        socket.emit('transaction:queued', {
          transactionId: validated.transactionId,
          status: 'queued',
          timestamp: new Date().toISOString(),
        });

        logger.info(`Queued mint_nft transaction: ${validated.transactionId}`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Validation failed';
        logger.error('Failed to queue mint_nft transaction', error);
        socket.emit('error', {
          error: errorMessage,
          transactionId: (data as any).transactionId,
        });
      }
    });

    socket.on('nftMint', async (data: unknown) => {
      try {
        logger.info(`[nftMint] Received request: ${JSON.stringify(data)}`);
        
        // Validate input
        if (!data) {
          const error = 'Invalid nftMint data: Missing dat';
          logger.error(`[nftMint] ${error}`);
          socket.emit('error', { error });
          return;
        }

        const mintData: { playerId?: string; playerSuiAddress: string; rewardType: string } = typeof data !== 'object' ? JSON.parse(data as string) : data;

        if (!mintData.playerId || !mintData.playerSuiAddress || !mintData.rewardType) {
          const error = 'Invalid nftMint data: missing required fields (playerId, playerSuiAddress, rewardType)';
          logger.error(`[nftMint] ${error}`);
          socket.emit('error', { error });
          return;
        }

        const { playerId, playerSuiAddress, rewardType } = mintData;

        logger.info(`[nftMint] Processing request: playerId=${playerId}, playerSuiAddress=${playerSuiAddress}, rewardType=${rewardType}`);

        // Step 1: Check that the player exists
        const pool = getPool();
        const playerResult = await pool.query(
          `SELECT id, sui_address FROM players WHERE id = $1 AND sui_address = $2 LIMIT 1`,
          [playerId, playerSuiAddress]
        );

        if (playerResult.rows.length === 0) {
          const error = `Player not found: id=${playerId}, address=${playerSuiAddress}`;
          logger.error(`[nftMint] ${error}`);
          socket.emit('error', { error });
          return;
        }

        logger.info(`[nftMint] Player exists: ${playerId}`);

        // Step 2: Check that the reward exists (from rewardsList)
        // First, check if rewardType is a valid badge_type
        let reward = getRewardByBadgeType(rewardType);
        
        // If not found by badge_type, check if it's a condition check type (first_game, first_game_created, wins)
        if (!reward) {
          logger.info(`[nftMint] Reward type ${rewardType} not found by badge_type, checking eligibility...`);
          const eligibleBadgeType = await shouldEarnReward(playerSuiAddress, rewardType);
          
          if (!eligibleBadgeType) {
            logger.info(`[nftMint] Reward not eligible or already earned, skipping: type=${rewardType}`);
            return;
          }

          reward = getRewardByBadgeType(eligibleBadgeType);
          if (!reward) {
            const error = `Reward configuration not found for badge_type: ${eligibleBadgeType}`;
            logger.error(`[nftMint] ${error}`);
            socket.emit('error', { error });
            return;
          }

          logger.info(`[nftMint] Found eligible reward: badgeType=${eligibleBadgeType}`);
        } else {
          // If reward was found by badge_type, still check eligibility
          const eligibleBadgeType = await shouldEarnReward(playerSuiAddress, rewardType);
          if (!eligibleBadgeType || eligibleBadgeType !== rewardType) {
            logger.info(`[nftMint] Reward not eligible or already earned, skipping: type=${rewardType}`);
            return;
          }
        }

        logger.info(`[nftMint] Reward exists: badgeType=${reward.nft.badge_type}`);

        // Step 3: Check that the reward is not already minted (in the database)
        const existingRewardResult = await pool.query(
          `SELECT id FROM rewards WHERE player_id = $1 AND reward_type = $2 LIMIT 1`,
          [playerId, reward.nft.badge_type]
        );

        if (existingRewardResult.rows.length > 0) {
          logger.info(`[nftMint] Reward already minted, skipping: playerId=${playerId}, badgeType=${reward.nft.badge_type}`);
          return;
        }

        logger.info(`[nftMint] Reward not already minted: badgeType=${reward.nft.badge_type}`);

        // Step 4: Check that the reward is not already in the queue
        const inQueue = await isRewardInQueue(playerId, playerSuiAddress, reward.nft.badge_type);
        if (inQueue) {
          const error = `Reward already in queue: playerId=${playerId}, badgeType=${reward.nft.badge_type}`;
          logger.warn(`[nftMint] ${error}`);
          socket.emit('error', { error });
          return;
        }

        logger.info(`[nftMint] Reward not in queue: badgeType=${reward.nft.badge_type}`);

        // Step 5: Add the reward to the queue
        const taskId = `mint_nft-${playerId}-${reward.nft.badge_type}-${Date.now()}-${Math.random().toString(36).substring(7)}`;
        const transactionId = taskId;

        const transactionData = {
          recipientAddress: playerSuiAddress,
          badgeType: reward.nft.badge_type,
          name: reward.nft.name,
          description: reward.nft.description,
          sourceUrl: reward.nft.sourceUrl,
        };

        await addToQueue(
          transactionId,
          'mint_nft',
          playerSuiAddress,
          transactionData,
          undefined,
          playerId
        );

        logger.info(`[nftMint] Added to queue: taskId=${taskId}, badgeType=${reward.nft.badge_type}`);

        // Step 6: Emit a mint-task-queued event to the client
        io?.to(`player:${playerSuiAddress}`).emit('mint-task-queued', {
          taskId,
          rewardType: reward.nft.badge_type,
          playerId,
          playerSuiAddress,
        });

        logger.info(`[nftMint] Emitted mint-task-queued event: taskId=${taskId}`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error('[nftMint] Failed to handle nftMint request', error);
        socket.emit('error', { error: errorMessage });
      }
    });
  });

  return io;
}

export function getSocketServer(): SocketIOServer | null {
  return io;
}


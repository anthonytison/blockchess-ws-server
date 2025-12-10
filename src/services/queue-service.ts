/**
 * Queue Service - Manages the transaction processing queue
 * 
 * This service processes blockchain transactions in a sequential, reliable manner.
 * It handles transactions for each player one at a time to ensure proper ordering
 * and prevent race conditions. The queue is stored in PostgreSQL for persistence
 * and reliability across server restarts.
 */

import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import {
  getNextPendingTransaction,
  updateTransactionStatus,
  incrementRetries,
  cleanupOldTransactions,
  deleteTransaction,
} from './database.js';
import { processTransaction } from './transaction-processor.js';
import { Server as SocketIOServer } from 'socket.io';

// Track which players are currently being processed to prevent concurrent processing
const processingPlayers = new Set<string>();

/**
 * Starts the queue processing system
 * 
 * This function sets up two interval timers:
 * 1. Main queue processor - runs at configured interval to process pending transactions
 * 2. Cleanup task - runs hourly to remove old completed/failed transactions
 */
export async function startQueueProcessor(io: SocketIOServer): Promise<void> {
  logger.info('Starting queue processor');

  // Process pending transactions at regular intervals
  setInterval(async () => {
    try {
      await processQueue(io);
    } catch (error) {
      logger.error('Error in queue processor', error);
    }
  }, config.queue.processingIntervalMs);

  // Clean up old transactions every hour (3600000ms)
  setInterval(async () => {
    try {
      await cleanupOldTransactions();
    } catch (error) {
      logger.error('Error cleaning up old transactions', error);
    }
  }, 3600000);

  logger.info('Queue processor started');
}

/**
 * Processes the queue for all players with pending transactions
 * 
 * This function finds all players who have pending transactions and starts
 * processing their queues. It ensures that each player's queue is processed
 * sequentially (one transaction at a time) to maintain proper ordering.
 */
async function processQueue(io: SocketIOServer): Promise<void> {
  const allPlayers = await getAllPlayersWithPendingTransactions();

  for (const playerAddress of allPlayers) {
    // Skip players already being processed to prevent concurrent processing
    if (processingPlayers.has(playerAddress)) {
      continue;
    }

    // Mark player as being processed and start queue processing
    // The finally block ensures the player is removed from the set even if an error occurs
    processingPlayers.add(playerAddress);
    processPlayerQueue(playerAddress, io).finally(() => {
      processingPlayers.delete(playerAddress);
    });
  }
}

/**
 * Retrieves all unique player addresses that have pending transactions
 * 
 * This function queries the database to find all players with pending transactions,
 * groups them by address, and orders them by the oldest transaction (FIFO).
 * This ensures fair processing across all players.
 */
async function getAllPlayersWithPendingTransactions(): Promise<string[]> {
  const { getPool } = await import('./database.js');
  const pool = getPool();
  
  // Get players with pending transactions, ordered by oldest transaction first
  // The LIMIT prevents processing too many players at once
  const result = await pool.query<{ player_sui_address: string }>(
    `SELECT player_sui_address
     FROM transaction_queue
     WHERE status = 'pending'
     AND player_sui_address IS NOT NULL
     GROUP BY player_sui_address
     ORDER BY MIN(created_at) ASC
     LIMIT 100`
  );

  return result.rows.map((row) => row.player_sui_address || '');
}

/**
 * Processes all pending transactions for a specific player sequentially
 * 
 * This function processes transactions one at a time for the given player address.
 * It handles retries, error recovery, and special cases like version mismatches
 * with shared objects. Transactions are processed in FIFO order to maintain
 * proper sequence.
 * 
 * Error handling:
 * - Failed transactions are retried with exponential backoff
 * - Version mismatch errors (common with Sui shared objects) get special handling
 * - NFT transactions that fail are kept in the queue for error visibility
 * - Non-NFT transactions that exceed max retries are deleted
 */
async function processPlayerQueue(
  playerAddress: string,
  io: SocketIOServer
): Promise<void> {
  logger.info(`[processPlayerQueue] Starting queue processing for player: ${playerAddress}`);
  
  // Process transactions until queue is empty
  while (true) {
    // Get the next pending transaction for this player (FIFO order)
    const transaction = await getNextPendingTransaction(playerAddress || null);

    if (!transaction) {
      logger.debug(`[processPlayerQueue] No pending transactions for player: ${playerAddress}`);
      break;
    }

    logger.info(
      `[processPlayerQueue] Processing transaction: id=${transaction.id}, type=${transaction.transaction_type}, retries=${transaction.retries}`
    );

    try {
      // Mark transaction as processing to prevent concurrent processing
      await updateTransactionStatus(transaction.id, 'processing');
      
      logger.info(`[processPlayerQueue] Transaction ${transaction.id} status updated to processing`);
      
      // Notify frontend that transaction is being processed
      io.to(`player:${playerAddress}`).emit('transaction:processing', {
        transactionId: transaction.id,
        status: 'processing',
        timestamp: new Date().toISOString(),
      });

      // Execute the transaction on the blockchain
      await processTransaction(transaction, io);

      // Mark as completed and clean up
      await updateTransactionStatus(transaction.id, 'completed');
      
      logger.info(`[processPlayerQueue] Transaction ${transaction.id} completed successfully`);
      
      // Delete completed transaction to keep queue clean
      await deleteTransaction(transaction.id);
      logger.debug(`[processPlayerQueue] Deleted completed transaction: ${transaction.id}`);
    } catch (error) {
      // Handle transaction failure with retry logic
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(
        `[processPlayerQueue] Transaction ${transaction.id} failed: ${errorMessage}`,
        error
      );

      // Increment retry counter
      await incrementRetries(transaction.id);

      const retries = transaction.retries + 1;
      logger.warn(
        `[processPlayerQueue] Transaction ${transaction.id} retry ${retries}/${config.queue.maxRetries}`
      );

      // Check if we've exceeded maximum retries
      if (retries >= config.queue.maxRetries) {
        // Mark transaction as failed
        await updateTransactionStatus(transaction.id, 'failed', errorMessage);
        
        logger.error(
          `[processPlayerQueue] Transaction ${transaction.id} failed after ${retries} retries: ${errorMessage}`
        );
        
        // Determine if we should notify the frontend about this error
        // Some errors (like "already exists" for NFTs) shouldn't show error messages
        const isNftAlreadyExists = transaction.transaction_type === 'mint_nft' && 
          (errorMessage.toLowerCase().includes('already exists') ||
           errorMessage.toLowerCase().includes('already minted') ||
           errorMessage.toLowerCase().includes('duplicate') ||
           errorMessage.toLowerCase().includes('already locked'));
        
        // Version mismatch errors are non-retriable and shouldn't show errors to users
        const isVersionMismatch = errorMessage.includes('is not available for consumption') || 
                                 errorMessage.includes('current version') ||
                                 errorMessage.includes('non-retriable');
        
        // Only send error notifications for unexpected failures
        if (!isNftAlreadyExists && !isVersionMismatch) {
          io.to(`player:${playerAddress}`).emit('transaction:result', {
            transactionId: transaction.id,
            status: 'error',
            error: errorMessage,
            timestamp: new Date().toISOString(),
          });
        } else {
          // Log why we're not sending the error notification
          if (isNftAlreadyExists) {
            logger.info(
              `[processPlayerQueue] Skipping error message for NFT that already exists: ${transaction.id}`
            );
          }
          if (isVersionMismatch) {
            logger.info(
              `[processPlayerQueue] Skipping error message for version mismatch (non-retriable): ${transaction.id}`
            );
          }
        }
        
        // Keep failed NFT transactions in the queue so users can see the error status
        // Delete other transaction types after max retries to keep queue clean
        if (transaction.transaction_type !== 'mint_nft') {
          await deleteTransaction(transaction.id);
          logger.info(`[processPlayerQueue] Deleted failed non-NFT transaction: ${transaction.id}`);
        } else {
          logger.info(
            `[processPlayerQueue] Keeping failed NFT transaction ${transaction.id} in queue for error visibility`
          );
        }
      } else {
        // Retry the transaction with exponential backoff
        await updateTransactionStatus(transaction.id, 'pending', errorMessage);
        
        // Version mismatch errors with shared objects need longer delays
        // This is common with Sui shared objects when multiple transactions try to use the same version
        const isVersionMismatch = errorMessage.includes('is not available for consumption') || 
                                  errorMessage.includes('current version');
        const baseDelay = isVersionMismatch && transaction.transaction_type === 'mint_nft' 
          ? 2000 // 2 seconds base delay for version mismatches
          : config.queue.retryDelayMs;
        // Exponential backoff: delay increases with each retry
        const retryDelay = baseDelay * retries;
        
        logger.info(
          `[processPlayerQueue] Retrying transaction ${transaction.id} in ${retryDelay}ms (attempt ${retries}${isVersionMismatch ? ', version mismatch detected' : ''})`
        );
        
        // Wait before retrying
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    }
  }
  
  logger.debug(`[processPlayerQueue] Finished processing queue for player: ${playerAddress}`);
}


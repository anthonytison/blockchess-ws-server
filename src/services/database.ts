import { Pool, PoolClient } from 'pg';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import {
  TransactionQueueItem,
  TransactionType,
  TransactionStatus,
} from '../types/index.js';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      host: config.database.host,
      port: config.database.port,
      database: config.database.database,
      user: config.database.user,
      password: config.database.password,
      ssl: config.database.ssl,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });

    pool.on('error', (err) => {
      logger.error('Unexpected database pool error', err);
    });
  }

  return pool;
}

export async function initializeDatabase(): Promise<void> {
  const pool = getPool();
  
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS transaction_queue (
        id TEXT PRIMARY KEY,
        transaction_type TEXT NOT NULL,
        player_sui_address TEXT,
        game_id TEXT,
        player_id TEXT,
        status TEXT NOT NULL,
        transaction_data JSONB NOT NULL,
        error_message TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        processed_at TIMESTAMP,
        retries INTEGER DEFAULT 0
      );
    `);

    // Check if retries column exists, add it if missing (migration)
    const columnCheck = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'transaction_queue' 
      AND column_name = 'retries'
    `);
    
    if (columnCheck.rows.length === 0) {
      await pool.query(`
        ALTER TABLE transaction_queue 
        ADD COLUMN retries INTEGER DEFAULT 0
      `);
      logger.info('Added retries column to transaction_queue table');
    }

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_transaction_queue_status 
      ON transaction_queue(status);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_transaction_queue_player 
      ON transaction_queue(player_sui_address);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_transaction_queue_created 
      ON transaction_queue(created_at);
    `);

    logger.info('Database initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize database', error);
    throw error;
  }
}

export async function addToQueue(
  id: string,
  transactionType: TransactionType,
  playerSuiAddress: string | null,
  transactionData: Record<string, unknown>,
  gameId?: string,
  playerId?: string
): Promise<void> {
  const pool = getPool();
  
  // For mint_nft transactions, check for duplicates (same player and badge type)
  if (transactionType === 'mint_nft' && playerSuiAddress && playerId) {
    const badgeType = (transactionData as any).badgeType;
    if (badgeType) {
      const existing = await pool.query(
        `SELECT id FROM transaction_queue
         WHERE transaction_type = 'mint_nft'
         AND player_sui_address = $1
         AND player_id = $2
         AND transaction_data->>'badgeType' = $3
         AND status IN ('pending', 'processing', 'completed')
         LIMIT 1`,
        [playerSuiAddress, playerId, badgeType]
      );
      
      if (existing.rows.length > 0) {
        logger.info(`Duplicate mint_nft transaction skipped: ${badgeType} for player ${playerSuiAddress}`);
        return; // Skip adding duplicate
      }
    }
  }
  
  await pool.query(
    `INSERT INTO transaction_queue 
     (id, transaction_type, player_sui_address, game_id, player_id, status, transaction_data, retries)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, transactionType, playerSuiAddress, gameId || null, playerId || null, 'pending', JSON.stringify(transactionData), 0]
  );
}

export async function getNextPendingTransaction(
  playerSuiAddress: string | null
): Promise<TransactionQueueItem | null> {
  const pool = getPool();
  
  // Get next pending transaction
  // Note: Failed NFT transactions have status 'failed', so they won't be picked up here
  // They're kept in the queue for error visibility but won't be reprocessed
  const result = await pool.query<TransactionQueueItem>(
    `SELECT * FROM transaction_queue
     WHERE status = 'pending'
     AND player_sui_address = $1
     ORDER BY created_at ASC
     LIMIT 1
     FOR UPDATE SKIP LOCKED`,
    [playerSuiAddress]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    ...row,
    transaction_data: typeof row.transaction_data === 'string' 
      ? JSON.parse(row.transaction_data) 
      : row.transaction_data,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
    processed_at: row.processed_at ? new Date(row.processed_at) : null,
  };
}

export async function updateTransactionStatus(
  id: string,
  status: TransactionStatus,
  errorMessage?: string
): Promise<void> {
  const pool = getPool();
  
  const updates: string[] = ['status = $2', 'updated_at = CURRENT_TIMESTAMP'];
  const values: unknown[] = [id, status];

  if (errorMessage) {
    updates.push('error_message = $3');
    values.push(errorMessage);
  }

  if (status === 'completed' || status === 'failed') {
    updates.push('processed_at = CURRENT_TIMESTAMP');
  }

  await pool.query(
    `UPDATE transaction_queue SET ${updates.join(', ')} WHERE id = $1`,
    values
  );
}

export async function incrementRetries(id: string): Promise<void> {
  const pool = getPool();
  
  await pool.query(
    `UPDATE transaction_queue 
     SET retries = retries + 1, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [id]
  );
}

export async function updateGameObjectId(gameId: string, objectId: string): Promise<void> {
  const pool = getPool();
  
  try {
    await pool.query(
      `UPDATE games SET object_id = $1 WHERE id = $2`,
      [objectId, gameId]
    );
    logger.info(`Updated game ${gameId} with object_id ${objectId}`);
  } catch (error) {
    logger.error(`Failed to update game object_id for game ${gameId}`, error);
    throw error;
  }
}

export async function createOrUpdateReward(
  playerId: string,
  rewardType: string,
  objectId: string
): Promise<void> {
  const pool = getPool();
  
  try {
    const existing = await pool.query(
      `SELECT id FROM rewards WHERE player_id = $1 AND reward_type = $2 LIMIT 1`,
      [playerId, rewardType]
    );

    if (existing.rows.length > 0) {
      await pool.query(
        `UPDATE rewards SET object_id = $1, created_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [objectId, existing.rows[0].id]
      );
      logger.info(`Updated reward for player ${playerId}, type ${rewardType}, object_id ${objectId}`);
    } else {
      // Let the database auto-generate the UUID for the id column
      await pool.query(
        `INSERT INTO rewards (reward_type, player_id, object_id, created_at)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
        [rewardType, playerId, objectId]
      );
      logger.info(`Created reward for player ${playerId}, type ${rewardType}, object_id ${objectId}`);
    }
  } catch (error) {
    logger.error(`Failed to create/update reward for player ${playerId}`, error);
    throw error;
  }
}

export async function deleteTransaction(id: string): Promise<void> {
  const pool = getPool();
  
  try {
    await pool.query(
      `DELETE FROM transaction_queue WHERE id = $1`,
      [id]
    );
    logger.info(`Deleted transaction ${id} from queue`);
  } catch (error) {
    logger.error(`Failed to delete transaction ${id}`, error);
    throw error;
  }
}

export async function cleanupOldTransactions(): Promise<void> {
  const pool = getPool();
  
  try {
    const result = await pool.query(
      `DELETE FROM transaction_queue
       WHERE status IN ('completed', 'failed')
       AND processed_at < NOW() - INTERVAL '24 hours'`
    );
    logger.info(`Cleaned up ${result.rowCount} old transactions`);
  } catch (error) {
    logger.error('Failed to cleanup old transactions', error);
  }
}

export async function getWaitingTransactionsForGame(gameId: string): Promise<TransactionQueueItem[]> {
  const pool = getPool();
  
  const result = await pool.query<TransactionQueueItem>(
    `SELECT * FROM transaction_queue
     WHERE game_id = $1
     AND status = 'waiting_for_object_id'
     ORDER BY created_at ASC`,
    [gameId]
  );

  return result.rows.map((row) => ({
    ...row,
    transaction_data: typeof row.transaction_data === 'string' 
      ? JSON.parse(row.transaction_data) 
      : row.transaction_data,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
    processed_at: row.processed_at ? new Date(row.processed_at) : null,
  }));
}

export async function updateWaitingTransactionWithObjectId(
  transactionId: string,
  objectId: string
): Promise<void> {
  const pool = getPool();
  
  await pool.query(
    `UPDATE transaction_queue 
     SET transaction_data = jsonb_set(transaction_data, '{gameObjectId}', $2::jsonb),
         status = 'pending',
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [transactionId, JSON.stringify(objectId)]
  );
  
  logger.info(`Updated waiting transaction ${transactionId} with object_id ${objectId}`);
}

export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info('Database connection pool closed');
  }
}


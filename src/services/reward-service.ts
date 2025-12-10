import { getPool } from './database.js';
import { logger } from '../utils/logger.js';

export interface RewardConfig {
  conditions: {
    check: string;
    value: number;
  };
  nft: {
    badge_type: string;
    name: string;
    description: string;
    sourceUrl: string;
  };
}

export const rewardsList: RewardConfig[] = [
  {
    conditions: {
      check: 'first_game',
      value: 1,
    },
    nft: {
      badge_type: 'first_game',
      name: 'First game',
      description: 'Congratulations on playing your first chess game',
      sourceUrl: 'https://raw.githubusercontent.com/anthonytison/blockchess-design/refs/heads/main/badges/reward_first_game.png',
    },
  },
  {
    conditions: {
      check: 'first_game_created',
      value: 1,
    },
    nft: {
      badge_type: 'first_game_created',
      name: 'First game created',
      description: 'Congratulations on creating your first chess game',
      sourceUrl: 'https://raw.githubusercontent.com/anthonytison/blockchess-design/refs/heads/main/badges/reward_first_game_created.png',
    },
  },
  {
    conditions: {
      check: 'wins',
      value: 1,
    },
    nft: {
      badge_type: 'first_game_won',
      name: 'First game won',
      description: 'Congratulations on winning your first chess game',
      sourceUrl: 'https://raw.githubusercontent.com/anthonytison/blockchess-design/refs/heads/main/badges/reward_first_game_won.png',
    },
  },
  {
    conditions: {
      check: 'wins',
      value: 10,
    },
    nft: {
      badge_type: '10_games_won',
      name: 'Already 10 games won',
      description: 'Congratulations on your 10th victory',
      sourceUrl: 'https://raw.githubusercontent.com/anthonytison/blockchess-design/refs/heads/main/badges/reward_10_games_won.png',
    },
  },
  {
    conditions: {
      check: 'wins',
      value: 50,
    },
    nft: {
      badge_type: '50_games_won',
      name: 'Already 50 games won',
      description: 'Congratulations on your 50th victory',
      sourceUrl: 'https://raw.githubusercontent.com/anthonytison/blockchess-design/refs/heads/main/badges/reward_50_games_won.png',
    },
  },
  {
    conditions: {
      check: 'wins',
      value: 100,
    },
    nft: {
      badge_type: '100_games_won',
      name: 'Already 100 games won',
      description: 'Congratulations on your 100th victory',
      sourceUrl: 'https://raw.githubusercontent.com/anthonytison/blockchess-design/refs/heads/main/badges/reward_100_games_won.png',
    },
  },
];

/**
 * Check if a player should earn a reward based on reward type
 * Returns the badge_type if eligible, null otherwise
 */
export async function shouldEarnReward(
  playerSuiAddress: string,
  rewardType: string
): Promise<string | null> {
  const pool = getPool();
  
  logger.info(`[shouldEarnReward] Checking reward eligibility: player=${playerSuiAddress}, type=${rewardType}`);

  let table: string = '';
  let badgeType: string = '';
  
  switch (rewardType) {
    case 'first_game':
      table = 'vw_users_no_first_game';
      badgeType = 'first_game';
      break;
    case 'first_game_created':
      table = 'vw_users_no_first_game_created';
      badgeType = 'first_game_created';
      break;
    case 'wins':
      table = 'vw_users_victories';
      break;
    default:
      logger.warn(`[shouldEarnReward] Unknown reward type: ${rewardType}`);
      return null;
  }

  // Check if player exists
  const playerResult = await pool.query(
    `SELECT id FROM players WHERE sui_address = $1 LIMIT 1`,
    [playerSuiAddress]
  );

  if (playerResult.rows.length === 0) {
    logger.warn(`[shouldEarnReward] Player not found: ${playerSuiAddress}`);
    return null;
  }

  const playerId = playerResult.rows[0].id;

  // Check if reward already exists in database
  if (badgeType) {
    const existingRewardResult = await pool.query(
      `SELECT id FROM rewards WHERE player_id = $1 AND reward_type = $2 LIMIT 1`,
      [playerId, badgeType]
    );

    if (existingRewardResult.rows.length > 0) {
      logger.info(`[shouldEarnReward] Reward already exists: player=${playerId}, type=${badgeType}`);
      return null;
    }
  }

  // For non-wins rewards, check the view
  if (rewardType !== 'wins') {
    const result = await pool.query(
      `SELECT * FROM ${table} WHERE suid = $1 LIMIT 1`,
      [playerSuiAddress]
    );

    if (result.rows.length === 0) {
      logger.info(`[shouldEarnReward] Player not eligible: player=${playerSuiAddress}, type=${rewardType}`);
      return null;
    }

    logger.info(`[shouldEarnReward] Player eligible for reward: player=${playerSuiAddress}, badgeType=${badgeType}`);
    return badgeType;
  }

  // For wins rewards, check victories and determine next reward
  const victoryResult = await pool.query(
    `SELECT * FROM ${table} WHERE suid = $1 LIMIT 1`,
    [playerSuiAddress]
  );

  if (victoryResult.rows.length === 0) {
    logger.info(`[shouldEarnReward] Player has no victories: player=${playerSuiAddress}`);
    return null;
  }

  const totalWins = victoryResult.rows[0].total || 0;
  logger.info(`[shouldEarnReward] Player victories: player=${playerSuiAddress}, wins=${totalWins}`);

  // Get earned rewards
  const earnedRewardsResult = await pool.query(
    `SELECT reward_type FROM rewards WHERE player_id = $1`,
    [playerId]
  );
  const earnedRewardTypes = new Set(earnedRewardsResult.rows.map((r: any) => r.reward_type));

  // Find next unearned wins reward
  const winsRewards = rewardsList.filter((r) => r.conditions.check === 'wins');
  const nextReward = winsRewards.find(
    (reward) => !earnedRewardTypes.has(reward.nft.badge_type)
  );

  if (!nextReward) {
    logger.info(`[shouldEarnReward] All wins rewards already earned: player=${playerSuiAddress}`);
    return null;
  }

  const shouldEarn = Number(totalWins) >= Number(nextReward.conditions.value);
  if (shouldEarn) {
    logger.info(
      `[shouldEarnReward] Player eligible for wins reward: player=${playerSuiAddress}, badgeType=${nextReward.nft.badge_type}, wins=${totalWins}, required=${nextReward.conditions.value}`
    );
    return nextReward.nft.badge_type;
  }

  logger.info(
    `[shouldEarnReward] Player not yet eligible: player=${playerSuiAddress}, wins=${totalWins}, required=${nextReward.conditions.value}`
  );
  return null;
}

/**
 * Get reward configuration by badge type
 */
export function getRewardByBadgeType(badgeType: string): RewardConfig | undefined {
  return rewardsList.find((r) => r.nft.badge_type === badgeType);
}

/**
 * Check if a reward is already in the queue
 */
export async function isRewardInQueue(
  playerId: string,
  playerSuiAddress: string,
  badgeType: string
): Promise<boolean> {
  const pool = getPool();

  const result = await pool.query(
    `SELECT id FROM transaction_queue
     WHERE transaction_type = 'mint_nft'
     AND player_id = $1
     AND player_sui_address = $2
     AND transaction_data->>'badgeType' = $3
     AND status IN ('pending', 'processing')
     LIMIT 1`,
    [playerId, playerSuiAddress, badgeType]
  );

  return result.rows.length > 0;
}


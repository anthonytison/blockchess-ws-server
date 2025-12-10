# Changelog - BlockChess WebSocket Server

## [1.1] - 2024

### Added
- **Transaction Sponsoring**: All blockchain transactions are now sponsored by the server
  - Users no longer need to pay gas fees
  - Sponsored transactions use `SUI_SPONSOR_PRIVATE_KEY` for gas payment
  - Automatic gas budget management
- **Queue System**: PostgreSQL-backed transaction queue for reliable processing
  - Sequential processing per player (prevents race conditions)
  - Automatic retry logic with exponential backoff
  - Support for version mismatch errors with shared objects
  - Queue survives server restarts
- **Logging System**: Configurable log levels via `LOG_LEVEL` environment variable
  - Supports: debug, info, warn, error
  - Production-ready logging with structured output
- **Error Handling**: Enhanced error handling for:
  - Version mismatch errors (common with Sui shared objects)
  - NFT authorization errors
  - Transaction execution failures
  - Non-retriable errors

### Changed
- **Architecture**: Queue processing moved to dedicated service
  - Better separation of concerns
  - Improved error recovery
  - Configurable processing intervals
- **Database Integration**: Automatic object ID updates after transactions
  - Game object IDs stored after creation
  - Reward object IDs stored after minting
  - Waiting move transactions processed automatically
- **Transaction Flow**: Improved transaction lifecycle management
  - Better status tracking
  - Real-time frontend notifications
  - Comprehensive error reporting

### Configuration
- New environment variables:
  - `LOG_LEVEL`: Control logging verbosity (default: info)
  - `QUEUE_PROCESSING_INTERVAL_MS`: How often to check for pending transactions (default: 1000ms)
  - `QUEUE_MAX_RETRIES`: Maximum retry attempts (default: 3)
  - `QUEUE_RETRY_DELAY_MS`: Base delay between retries (default: 5000ms)
  - `SUI_SPONSOR_PRIVATE_KEY`: Private key for transaction sponsoring
  - `SUI_SPONSOR_ADDRESS`: Sponsor address (for validation)
  - `SUI_GAS_BUDGET`: Gas budget per transaction (default: 100000000)

### Documentation
- Added comprehensive code comments explaining queue processing
- Updated README with queue system architecture
- Added `.env.example` file with all required variables
- Documented transaction sponsoring process
- Added troubleshooting guide for authorization errors

### Bug Fixes
- Fixed version mismatch errors with retry logic
- Improved handling of NFT authorization errors
- Better error messages for debugging
- Fixed race conditions in queue processing

### Notes
- **Breaking Change**: The `SUI_SPONSOR_PRIVATE_KEY` environment variable is now required
- The sponsor address must match the `authorized_minter` in BadgeRegistry for NFT minting
- Use the `update-authorized-minter.ts` script if authorization errors occur
- Queue system ensures transactions are processed in order per player

---

## [1.0] - Initial Release

### Features
- Socket.IO server for real-time communication
- Transaction queue system
- Database integration with PostgreSQL
- Support for create_game, make_move, end_game, and mint_nft transactions
- Real-time transaction status updates

